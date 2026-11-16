#!/bin/sh
# Copies the package files onto a running router for development, without
# building packages. Usage: tools/deploy.sh root@router
#
# Only files are written. Existing directories are never replaced or have
# their owner or mode changed: an earlier version extracted a tarball over /
# with `cp -a`, which gave /, /usr, /etc and others the staging directory's
# owner and mode and stopped ubusd (it runs as user ubus) from starting.

set -eu

target=${1:?usage: $0 user@router}
root=$(cd "$(dirname "$0")/.." && pwd)
be=$root/tailscale-vnode/files
ui=$root/luci-app-tailscale-vnode

# <source> <destination> <mode>
manifest() {
	cat <<-EOF
	$be/tailscale-vnode.init /etc/init.d/tailscale-vnode 755
	$be/tailscale-vnode.cli /usr/sbin/tailscale-vnode 755
	$be/tailscale-vnode.hotplug-dhcp /etc/hotplug.d/dhcp/50-tailscale-vnode 644
	$be/vnode.sh /usr/lib/tailscale-vnode/vnode.sh 644
	$be/dns.sh /usr/lib/tailscale-vnode/dns.sh 644
	$be/tailscaled-vnode /usr/lib/tailscale-vnode/tailscaled-vnode 755
	$be/tailscale-vnode.upgrade /lib/upgrade/keep.d/tailscale-vnode 644
	$be/fw4-forward.nft /usr/share/nftables.d/chain-pre/forward/30-tailscale-vnode.nft 644
	$be/fw4-input.nft /usr/share/nftables.d/chain-pre/input/30-tailscale-vnode.nft 644
	$ui/root/usr/libexec/rpcd/tailscale-vnode /usr/libexec/rpcd/tailscale-vnode 755
	$ui/root/usr/share/rpcd/acl.d/luci-app-tailscale-vnode.json /usr/share/rpcd/acl.d/luci-app-tailscale-vnode.json 644
	$ui/root/usr/share/luci/menu.d/luci-app-tailscale-vnode.json /usr/share/luci/menu.d/luci-app-tailscale-vnode.json 644
	$ui/htdocs/luci-static/resources/view/tailscale-vnode/nodes.js /www/luci-static/resources/view/tailscale-vnode/nodes.js 644
	$ui/htdocs/luci-static/resources/tailscale-vnode/topology.js /www/luci-static/resources/tailscale-vnode/topology.js 644
	EOF
}

# Translations: compiled to .lmo here (the SDK normally does this) and sent
# over their own connection, as a here-document cannot carry binary data.
# Language directories map to LuCI's file suffixes like luci.mk does.
for po in "$ui"/po/*/tailscale-vnode.po; do
	lang=$(basename "$(dirname "$po")")
	[ "$lang" = templates ] && continue
	case "$lang" in
		zh_Hans) suffix=zh-cn ;;
		zh_Hant) suffix=zh-tw ;;
		*) suffix=$(echo "$lang" | tr 'A-Z_' 'a-z-') ;;
	esac
	lmo=$(mktemp)
	node "$root/tools/po2lmo.js" "$po" "$lmo"
	dst=/usr/lib/lua/luci/i18n/tailscale-vnode.$suffix.lmo
	# shellcheck disable=SC2029 # $dst is meant to expand here
	ssh "$target" "cat > '$dst.tsvn-new' && chown root:root '$dst.tsvn-new' && chmod 644 '$dst.tsvn-new' && mv -f '$dst.tsvn-new' '$dst'" < "$lmo"
	rm -f "$lmo"
done

# One shell script that recreates every file from a here-document; mkdir -p
# only creates missing directories and leaves existing ones untouched.
{
	echo 'set -e'
	manifest | while read -r src dst mode; do
		echo "mkdir -p '$(dirname "$dst")'"
		echo "cat > '$dst.tsvn-new' <<'TSVN_EOF_MARK'"
		cat "$src"
		echo 'TSVN_EOF_MARK'
		echo "chown root:root '$dst.tsvn-new'; chmod $mode '$dst.tsvn-new'; mv -f '$dst.tsvn-new' '$dst'"
	done
	echo '[ -e /etc/config/tailscale-vnode ] || { cp /dev/null /etc/config/tailscale-vnode; chmod 644 /etc/config/tailscale-vnode; }'
	echo 'rm -f /tmp/luci-indexcache* /tmp/luci-modulecache/* 2>/dev/null; /etc/init.d/rpcd reload'
	# LuCI versions its JavaScript URLs with the package database's mtime,
	# so browsers keep running cached views after files are copied in
	# without a package install. Touching it (contents unchanged) makes them
	# fetch the new ones.
	# shellcheck disable=SC2016 # expands on the router
	echo 'for db in /lib/apk/db/installed /usr/lib/opkg/status; do [ -e "$db" ] && touch "$db"; done'
	echo 'echo deployed'
} | ssh "$target" sh -s
