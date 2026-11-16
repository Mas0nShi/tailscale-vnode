# SPDX-License-Identifier: GPL-2.0-only
#
# Shared helpers for tailscale-vnode. Sourced by the init script, the CLI
# and the rpcd plugin.
#
# Every object created here carries the "tsv" prefix and is owned by this
# package: netns tsv-<node>, veth tsvh<i>/tsvn<i>, nft table inet
# tailscale_vnode (host and per-namespace), and /etc/netns/tsv-<node>.
# Teardown removes exactly those objects and nothing else.

# shellcheck disable=SC2034 # used by the scripts that source this file
VN_CONF=tailscale-vnode
VN_STATE_ROOT=/etc/tailscale-vnode
VN_RUN=/var/run/tailscale-vnode
VN_TABLE=tailscale_vnode
VN_TAILSCALED=/usr/sbin/tailscaled
VN_TAILSCALE=/usr/sbin/tailscale

. /lib/functions.sh

vn_log() { logger -t tailscale-vnode "$*"; }

vn_ip2int() {
	local IFS=.
	# shellcheck disable=SC2086 # split on IFS=. on purpose
	set -- $1
	echo $(( ($1 << 24) | ($2 << 16) | ($3 << 8) | $4 ))
}

vn_int2ip() {
	echo "$(( ($1 >> 24) & 255 )).$(( ($1 >> 16) & 255 )).$(( ($1 >> 8) & 255 )).$(( $1 & 255 ))"
}

vn_is_ipv4() {
	echo "$1" | grep -qE '^([0-9]{1,3}\.){3}[0-9]{1,3}$' || return 1
	local IFS=. o
	for o in $1; do [ "$o" -le 255 ] || return 1; done
}

vn_is_mac() {
	echo "$1" | grep -qiE '^([0-9a-f]{2}:){5}[0-9a-f]{2}$'
}

# Prints the current IPv4 address of target $1: the address itself, or for a
# MAC address the first match in the DHCP leases, the neighbour table, then
# the static DHCP hosts. Fails if nothing is known about it.
vn_resolve_target() {
	local mac ip
	if vn_is_ipv4 "$1"; then
		echo "$1"
		return 0
	fi
	vn_is_mac "$1" || return 1
	mac=$(echo "$1" | tr 'A-F' 'a-f')

	ip=$(awk -v m="$mac" 'tolower($2) == m { print $3; exit }' /tmp/dhcp.leases 2>/dev/null)
	[ -n "$ip" ] || ip=$(ip -4 neigh show 2>/dev/null |
		awk -v m="$mac" 'tolower($5) == m && $NF != "FAILED" && $NF != "INCOMPLETE" { print $1; exit }')
	[ -n "$ip" ] || ip=$(_vn_static_ip "$mac")
	vn_is_ipv4 "$ip" && echo "$ip"
}

_vn_static_ip() {
	local want="$1"
	VN_STATIC_IP=''
	_vn_host() {
		local macs m ip
		config_get macs "$1" mac
		config_get ip "$1" ip
		for m in $macs; do
			[ "$(echo "$m" | tr 'A-F' 'a-f')" = "$want" ] && VN_STATIC_IP=$ip
		done
	}
	( config_load dhcp; config_foreach _vn_host host; echo "$VN_STATIC_IP" )
}

# Reads the globals into VN_SUBNET_BASE (integer network address),
# VN_MAX_NODES and VN_BASE_PORT.
vn_load_globals() {
	local subnet prefix base
	config_get subnet globals subnet '198.51.100.0/24'
	config_get VN_BASE_PORT globals base_port 41642
	config_get_bool VN_INBOUND globals inbound 0
	prefix=${subnet#*/}
	base=${subnet%/*}
	if ! { [ "$prefix" -ge 8 ] 2>/dev/null && [ "$prefix" -le 30 ] && vn_is_ipv4 "$base"; }; then
		vn_log "invalid globals.subnet '$subnet'"
		return 1
	fi
	# tailscaled treats an interface with only link-local addresses as down
	# and never contacts the control server.
	case "$base" in 169.254.*)
		vn_log "globals.subnet '$subnet' is link-local; tailscaled would consider the namespace offline"
		return 1
		;;
	esac
	VN_SUBNET_BASE=$(( $(vn_ip2int "$base") & ~((1 << (32 - prefix)) - 1) ))
	# shellcheck disable=SC2034 # read by the init script
	VN_MAX_NODES=$(( 1 << (30 - prefix) ))
}

# Sets VN_NS, VN_HOST_IF, VN_NS_IF, VN_HOST_IP, VN_NS_IP for node $1 at index $2.
vn_names() {
	VN_NS="tsv-$1"
	VN_HOST_IF="tsvh$2"
	VN_NS_IF="tsvn$2"
	VN_HOST_IP=$(vn_int2ip $(( VN_SUBNET_BASE + $2 * 4 + 1 )))
	VN_NS_IP=$(vn_int2ip $(( VN_SUBNET_BASE + $2 * 4 + 2 )))
}

vn_socket() { echo "$VN_RUN/$1.sock"; }
vn_statedir() { echo "$VN_STATE_ROOT/$1"; }

# Host-side NAT shared by all nodes. Traffic from a namespace leaves as the
# router: towards the LAN so the target replies to its gateway without a
# route to the link network, towards the WAN like any routed client.
vn_host_up() {
	nft -f - <<-EOF
		table inet $VN_TABLE
		delete table inet $VN_TABLE
		table inet $VN_TABLE {
			chain srcnat {
				type nat hook postrouting priority srcnat; policy accept;
				iifname "tsvh*" oifname != "tsvh*" masquerade
			}
			# Inbound connections (globals.inbound): a node's UDP port on the
			# router leads to that node. The map is filled per node by
			# vn_node_inbound and stays empty otherwise.
			map inbound {
				type inet_service : ipv4_addr
			}
			chain dstnat {
				type nat hook prerouting priority dstnat; policy accept;
				iifname != "tsvh*" fib daddr type local dnat ip to udp dport map @inbound
			}
		}
	EOF
}

# The router's address towards its default route: what peers on the
# upstream network can reach it at.
vn_wan_ip() {
	ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -1
}

# Withdraws the UDP port forwarded to node $1, if any.
_vn_inbound_drop() {
	local old
	old=$(cat "$VN_RUN/$1.inport" 2>/dev/null)
	[ -n "$old" ] && nft delete element inet "$VN_TABLE" inbound "{ $old }" 2>/dev/null
	rm -f "$VN_RUN/$1.inport"
}

# Forwards UDP port $3 of the router to node $1 (index $2) when inbound
# connections are enabled, and withdraws whatever was forwarded to it before.
vn_node_inbound() {
	local name="$1" idx="$2" port="$3"
	vn_names "$name" "$idx"
	_vn_inbound_drop "$name"
	[ "$VN_INBOUND" = 1 ] || return 0
	nft add element inet "$VN_TABLE" inbound "{ $port : $VN_NS_IP }" && echo "$port" > "$VN_RUN/$name.inport"
}

vn_host_down() {
	nft delete table inet "$VN_TABLE" 2>/dev/null
	return 0
}

# Builds the namespace, veth pair and in-namespace NAT for node $1 (index $2)
# forwarding to IPv4 address $3. An empty $3 brings the node up without
# forwarding, for a MAC target whose address is not known yet. Idempotent: an
# existing namespace of the same name is replaced.
#
# $VN_RUN/<node>.idx records the index the namespace was built for, and
# <node>.gen changes on every rebuild; the init script passes it to procd so
# that a rebuilt namespace also restarts the daemon that lives in it.
vn_node_up() {
	local name="$1" idx="$2" ip="$3"
	vn_names "$name" "$idx"
	vn_node_down "$name" "$idx"
	mkdir -p "$VN_RUN"

	ip netns add "$VN_NS" || return 1
	ip link add "$VN_HOST_IF" type veth peer name "$VN_NS_IF" netns "$VN_NS" || { vn_node_down "$name" "$idx"; return 1; }
	ip addr add "$VN_HOST_IP/30" dev "$VN_HOST_IF"
	ip link set "$VN_HOST_IF" up

	ip netns exec "$VN_NS" sh -s <<-EOF || { vn_node_down "$name" "$idx"; return 1; }
		set -e
		ip link set lo up
		ip addr add $VN_NS_IP/30 dev $VN_NS_IF
		ip link set $VN_NS_IF up
		ip route add default via $VN_HOST_IP
		sysctl -qw net.ipv4.ip_forward=1
		nft -f - <<-NFT
			table inet $VN_TABLE {
				chain dstnat {
					type nat hook prerouting priority dstnat; policy accept;
				}
				chain srcnat {
					type nat hook postrouting priority srcnat; policy accept;
				}
			}
		NFT
	EOF
	vn_node_set_target "$name" "$idx" "$ip"

	# ip netns exec bind-mounts this over /etc/resolv.conf. The host's
	# dnsmasq answers on the veth address; asking it directly also survives
	# dns_redirect, which hijacks every forwarded port-53 query.
	mkdir -p "/etc/netns/$VN_NS"
	echo "nameserver $VN_HOST_IP" > "/etc/netns/$VN_NS/resolv.conf"
	mkdir -p "$(vn_statedir "$name")"
	chmod 700 "$(vn_statedir "$name")"
	echo "$idx" > "$VN_RUN/$name.idx"
	cat /proc/sys/kernel/random/uuid > "$VN_RUN/$name.gen"
}

# Makes sure node $1's namespace can be found by name. Another program may
# mount a fresh /run/netns over ours (dae does when it starts after us),
# which hides the names while the namespaces live on with the tailscaled
# inside them. The name is then attached again from that process.
vn_ns_ensure() {
	local sock pid
	[ -e "/var/run/netns/tsv-$1" ] && return 0
	sock=$(vn_socket "$1")
	for pid in $(pidof tailscaled); do
		tr '\0' '\n' < "/proc/$pid/cmdline" 2>/dev/null | grep -qx "$sock" || continue
		[ "$(readlink "/proc/$pid/ns/net")" = "$(readlink /proc/1/ns/net)" ] && continue
		ip netns attach "tsv-$1" "$pid" 2>/dev/null || return 1
		vn_log "node $1: namespace name was hidden (/run/netns mounted over), attached again"
		return 0
	done
	return 1
}

# True if node $1's namespace exists and was built for index $2, so a reload
# can leave it (and the tailscaled inside) alone.
vn_node_alive() {
	vn_ns_ensure "$1" &&
		[ "$(cat "$VN_RUN/$1.idx" 2>/dev/null)" = "$2" ] &&
		ip link show "tsvh$2" >/dev/null 2>&1
}

# Points node $1 (index $2) at IPv4 address $3, or at nothing when $3 is
# empty. Only the namespace's NAT rules change: tailscaled keeps running and
# established tunnels stay up.
vn_node_set_target() {
	local name="$1" idx="$2" ip="$3"
	vn_names "$name" "$idx"
	vn_ns_ensure "$name"
	ip netns exec "$VN_NS" nft -f - <<-EOF || return 1
		flush chain inet $VN_TABLE dstnat
		flush chain inet $VN_TABLE srcnat
		$([ -n "$ip" ] && echo "add rule inet $VN_TABLE dstnat iifname \"tailscale0\" fib daddr type local ip daddr != 100.100.100.100 dnat ip to $ip")
		$([ -n "$ip" ] && echo "add rule inet $VN_TABLE srcnat oifname \"$VN_NS_IF\" ip daddr $ip masquerade")
	EOF
	echo "$ip" > "$VN_RUN/$name.target"
}

vn_node_target_ip() { cat "$VN_RUN/$1.target" 2>/dev/null; }

# Removes node $1's namespace and runtime files. $2 is its index if known;
# without it the host end of the veth pair disappears with the namespace.
vn_node_down() {
	_vn_inbound_drop "$1"
	rm -f "$VN_RUN/$1.target" "$VN_RUN/$1.idx" "$VN_RUN/$1.gen" "$VN_RUN/$1.dns"
	vn_ns_ensure "$1"
	ip netns del "tsv-$1" 2>/dev/null
	[ -n "$2" ] && ip link del "tsvh$2" 2>/dev/null
	rm -rf "/etc/netns/tsv-$1"
	rm -f "$(vn_socket "$1")"
	return 0
}

# Removes every namespace, link and netns config this package could have
# created, including ones whose node section has since been deleted.
vn_teardown_all() {
	local ns link
	for ns in $(ip netns list 2>/dev/null | awk '{print $1}'); do
		case "$ns" in tsv-*) ip netns del "$ns" 2>/dev/null ;; esac
	done
	for link in $(ip -o link show 2>/dev/null | awk -F': ' '{print $2}' | cut -d@ -f1); do
		case "$link" in tsvh[0-9]*) ip link del "$link" 2>/dev/null ;; esac
	done
	rm -rf /etc/netns/tsv-*
	rm -rf "$VN_RUN"
	vn_host_down
}

# Calls $1 for every node section as: $1 <name> <index>.
#
# A node's index picks its veth names, link addresses and default port, so it
# must not change while the node exists: it is allocated once, as the lowest
# index no other node holds, and kept in the node's state directory. Adding,
# removing or reordering nodes never renumbers the others.
vn_foreach_node() {
	VN_USED=' '
	_vn_used() { case "$VN_USED" in *" $1 "*) return 0 ;; esac; return 1; }
	_vn_stored_idx() {
		local i
		i=$(cat "$VN_STATE_ROOT/$1/index" 2>/dev/null)
		case "$i" in ''|*[!0-9]*) return 1 ;; esac
		echo "$i"
	}
	# First pass: indices already held. A duplicate (a copied state
	# directory) is dropped from the later node, which gets a new one.
	_vn_claim() {
		local i
		i=$(_vn_stored_idx "$1") || return 0
		if _vn_used "$i"; then
			rm -f "$VN_STATE_ROOT/$1/index"
		else
			VN_USED="$VN_USED$i "
		fi
	}
	_vn_each() {
		local i
		if ! i=$(_vn_stored_idx "$1"); then
			i=0
			while _vn_used "$i"; do i=$((i + 1)); done
			VN_USED="$VN_USED$i "
			mkdir -p "$VN_STATE_ROOT/$1"
			chmod 700 "$VN_STATE_ROOT/$1"
			echo "$i" > "$VN_STATE_ROOT/$1/index"
		fi
		"$VN_CB" "$1" "$i"
	}
	VN_CB=$1
	config_foreach _vn_claim node
	config_foreach _vn_each node
}

# Prints the node's port: its own, or base_port + index.
vn_node_port() {
	local port
	config_get port "$1" port
	[ -n "$port" ] && echo "$port" || echo $(( VN_BASE_PORT + $2 ))
}

vn_ts() {
	local name="$1"
	shift
	"$VN_TAILSCALE" --socket "$(vn_socket "$name")" "$@"
}
