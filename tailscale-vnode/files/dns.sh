# SPDX-License-Identifier: GPL-2.0-only
#
# Cloudflare DNS records for tailscale-vnode nodes. Sourced after vnode.sh.
#
# Each node with a record name gets an A record pointing at its Tailscale
# IPv4 address, DNS only (not proxied: Cloudflare cannot reach 100.x).
# Records are created with the comment "managed by tailscale-vnode: <node>"
# and only records carrying that exact comment are ever changed or deleted;
# a name that already has other records is reported as a conflict.
#
# The API token lives in $VN_CF_TOKEN (mode 600), never in /etc/config, and
# reaches curl on stdin so it never appears in a process list.
#
# Per node, $VN_STATE_ROOT/<node>/dns holds "<zone id> <record id> <name>"
# of the record it owns, and $VN_RUN/<node>.dns its last sync result as
# "<state> <message>", state being ok, pending, off, conflict or error.

VN_CF_API=https://api.cloudflare.com/client/v4
VN_CF_TOKEN=$VN_STATE_ROOT/cloudflare.token

vn_dns_comment() { echo "managed by tailscale-vnode: $1"; }

vn_is_fqdn() {
	echo "$1" | grep -qE '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9]$'
}

# True if $1 has the shape of a Cloudflare API token.
vn_cf_token_valid() {
	echo "$1" | grep -qE '^[A-Za-z0-9_-]{20,200}$'
}

# Calls the Cloudflare API: vn_cf <method> <path> [<json body>]. Prints the
# response; a transport failure is turned into an API-style error.
vn_cf() {
	local method="$1" url="$VN_CF_API$2" body="$3" out
	if [ ! -s "$VN_CF_TOKEN" ]; then
		echo '{"success":false,"errors":[{"message":"no Cloudflare API token is set"}]}'
		return 0
	fi
	set -- -X "$method" "$url"
	[ -n "$body" ] && set -- "$@" -H 'Content-Type: application/json' --data "$body"
	out=$(printf 'header = "Authorization: Bearer %s"\n' "$(cat "$VN_CF_TOKEN")" |
		curl -sS --max-time 10 -K - "$@" 2>&1)
	# shellcheck disable=SC1003 # tr deletes quotes and backslashes
	case "$out" in
		'{'*) echo "$out" ;;
		*) printf '{"success":false,"errors":[{"message":"%s"}]}\n' "$(echo "$out" | head -1 | tr -d '"\\')" ;;
	esac
}

vn_cf_ok() { [ "$(echo "$1" | jsonfilter -e '@.success' 2>/dev/null)" = true ]; }
vn_cf_error() {
	local msg
	msg=$(echo "$1" | jsonfilter -e '@.errors[0].message' 2>/dev/null)
	echo "${msg:-unexpected response from Cloudflare}"
}

# The record name configured for node $1, or nothing when it has none.
vn_dns_name() {
	local on suffix name host
	config_get_bool on globals dns_enabled 0
	[ "$on" = 1 ] || return 0
	config_get_bool on "$1" dns 1
	[ "$on" = 1 ] || return 0
	config_get name "$1" dns_name
	if [ -z "$name" ]; then
		config_get suffix globals dns_suffix
		suffix=${suffix#.}
		[ -n "$suffix" ] || return 0
		config_get host "$1" hostname "$1"
		name=$host.$suffix
	fi
	echo "${name%.}" | tr 'A-Z' 'a-z'
}

# Sets VN_ZONE_ID to the zone (among those the token can see) that holds
# name $1: the longest zone name the name ends with. Fails with VN_DNS_ERR.
vn_dns_zone() {
	local name="$1" n i zname best=''
	VN_ZONE_ID=''
	if [ -z "$VN_ZONES" ]; then
		VN_ZONES=$(vn_cf GET '/zones?per_page=50')
		vn_cf_ok "$VN_ZONES" || { VN_DNS_ERR=$(vn_cf_error "$VN_ZONES"); VN_ZONES=''; return 1; }
	fi
	n=$(echo "$VN_ZONES" | jsonfilter -e '@.result[*].id' | wc -l)
	i=0
	while [ $i -lt "$n" ]; do
		zname=$(echo "$VN_ZONES" | jsonfilter -e "@.result[$i].name")
		case "$name" in
			"$zname"|*".$zname")
				if [ ${#zname} -gt ${#best} ]; then
					best=$zname
					VN_ZONE_ID=$(echo "$VN_ZONES" | jsonfilter -e "@.result[$i].id")
				fi
				;;
		esac
		i=$((i + 1))
	done
	[ -n "$VN_ZONE_ID" ] && return 0
	VN_DNS_ERR="the API token cannot manage any zone that contains $name"
	return 1
}

# Deletes record $2 in zone $1 if it is still the one node $3 created.
# Only Cloudflare saying the record does not exist counts as already gone;
# any other failure (no token, network) keeps the record on the books.
vn_dns_delete() {
	local js code
	js=$(vn_cf GET "/zones/$1/dns_records/$2")
	if ! vn_cf_ok "$js"; then
		code=$(echo "$js" | jsonfilter -e '@.errors[0].code' 2>/dev/null)
		case "$code" in 81044|7003) return 0 ;; esac
		VN_DNS_ERR=$(vn_cf_error "$js")
		return 1
	fi
	[ "$(echo "$js" | jsonfilter -e '@.result.comment')" = "$(vn_dns_comment "$3")" ] || return 0
	js=$(vn_cf DELETE "/zones/$1/dns_records/$2")
	vn_cf_ok "$js" || { VN_DNS_ERR=$(vn_cf_error "$js"); return 1; }
	vn_log "node $3: removed DNS record $(echo "$js" | jsonfilter -e '@.result.id' 2>/dev/null)"
}

vn_dns_status() {
	mkdir -p "$VN_RUN"
	echo "$2 $3" > "$VN_RUN/$1.dns"
}

# Brings node $1's record in line with its configured name and current
# Tailscale address.
vn_dns_sync_node() {
	local node="$1" want ip js mine n i id type content comment ours='' theirs=0 \
		old_zone='' old_id='' old_name=''

	want=$(vn_dns_name "$node")
	[ -s "$VN_STATE_ROOT/$node/dns" ] && read -r old_zone old_id old_name < "$VN_STATE_ROOT/$node/dns"

	# A record under an old name (renamed, or DNS turned off) goes first.
	if [ -n "$old_id" ] && [ "$old_name" != "$want" ]; then
		if ! vn_dns_delete "$old_zone" "$old_id" "$node"; then
			vn_dns_status "$node" error "could not remove the old record $old_name: $VN_DNS_ERR"
			return 1
		fi
		rm -f "$VN_STATE_ROOT/$node/dns"
	fi

	if [ -z "$want" ]; then
		vn_dns_status "$node" off ""
		return 0
	fi
	if ! vn_is_fqdn "$want"; then
		vn_dns_status "$node" error "$want is not a valid DNS name"
		return 1
	fi

	# A daemon that was just (re)started has no address for a few seconds;
	# wait until it has settled (up to 20 s) before looking.
	local tries=0 state
	while [ -S "$(vn_socket "$node")" ] && [ $tries -lt 20 ]; do
		state=$(vn_ts "$node" status --json 2>/dev/null | jsonfilter -e '@.BackendState' 2>/dev/null)
		case "$state" in Running|NeedsLogin|NeedsMachineAuth|Stopped) break ;; esac
		sleep 1
		tries=$((tries + 1))
	done

	ip=''
	[ -S "$(vn_socket "$node")" ] &&
		ip=$(vn_ts "$node" status --json 2>/dev/null | jsonfilter -e '@.Self.TailscaleIPs[0]' 2>/dev/null)
	if ! vn_is_ipv4 "$ip"; then
		# Not logged in or not running: keep whatever record exists.
		vn_dns_status "$node" pending "$want: waiting for the node's Tailscale address"
		return 0
	fi

	vn_dns_zone "$want" || { vn_dns_status "$node" error "$VN_DNS_ERR"; return 1; }

	js=$(vn_cf GET "/zones/$VN_ZONE_ID/dns_records?name=$want&per_page=50")
	vn_cf_ok "$js" || { vn_dns_status "$node" error "$(vn_cf_error "$js")"; return 1; }
	mine=$(vn_dns_comment "$node")
	n=$(echo "$js" | jsonfilter -e '@.result[*].id' | wc -l)
	i=0
	while [ $i -lt "$n" ]; do
		id=$(echo "$js" | jsonfilter -e "@.result[$i].id")
		type=$(echo "$js" | jsonfilter -e "@.result[$i].type")
		comment=$(echo "$js" | jsonfilter -e "@.result[$i].comment")
		if [ "$type" = A ] && [ "$comment" = "$mine" ] && [ -z "$ours" ]; then
			ours=$id
			content=$(echo "$js" | jsonfilter -e "@.result[$i].content")
		else
			theirs=$((theirs + 1))
		fi
		i=$((i + 1))
	done

	if [ -z "$ours" ] && [ $theirs -gt 0 ]; then
		vn_dns_status "$node" conflict "$want already has DNS records that tailscale-vnode did not create; it leaves them alone"
		return 1
	fi

	if [ -z "$ours" ]; then
		js=$(vn_cf POST "/zones/$VN_ZONE_ID/dns_records" \
			"{\"type\":\"A\",\"name\":\"$want\",\"content\":\"$ip\",\"ttl\":1,\"proxied\":false,\"comment\":\"$mine\"}")
		vn_cf_ok "$js" || { vn_dns_status "$node" error "$(vn_cf_error "$js")"; return 1; }
		ours=$(echo "$js" | jsonfilter -e '@.result.id')
		vn_log "node $node: created DNS record $want -> $ip"
	elif [ "$content" != "$ip" ]; then
		js=$(vn_cf PATCH "/zones/$VN_ZONE_ID/dns_records/$ours" "{\"content\":\"$ip\",\"proxied\":false}")
		vn_cf_ok "$js" || { vn_dns_status "$node" error "$(vn_cf_error "$js")"; return 1; }
		vn_log "node $node: updated DNS record $want -> $ip"
	fi

	echo "$VN_ZONE_ID $ours $want" > "$VN_STATE_ROOT/$node/dns"
	vn_dns_status "$node" ok "$want"
}

# Removes node $1's record (before the node itself is deleted).
vn_dns_remove_node() {
	local zone id name
	[ -s "$VN_STATE_ROOT/$1/dns" ] || return 0
	read -r zone id name < "$VN_STATE_ROOT/$1/dns"
	vn_dns_delete "$zone" "$id" "$1" || return 1
	rm -f "$VN_STATE_ROOT/$1/dns" "$VN_RUN/$1.dns"
}

# dnsmasq's rebind protection drops answers in 100.64.0.0/10, so LAN clients
# asking the router would not resolve the records. When enabled, every
# dnsmasq instance gets a runtime snippet (in its /tmp conf-dir; nothing in
# /etc/config/dhcp changes) allowing the configured domains, and dnsmasq is
# restarted if the snippet changed.
vn_dns_rebind() {
	local on rebind suffix domains='' conf dir file want d changed=0
	config_get_bool on globals dns_enabled 0
	config_get_bool rebind globals dns_rebind 1
	if [ "$on" = 1 ] && [ "$rebind" = 1 ]; then
		config_get suffix globals dns_suffix
		suffix=${suffix#.}
		[ -n "$suffix" ] && domains=$suffix
		_vn_rebind_node() {
			local name
			config_get name "$1" dns_name
			name=${name%.}
			[ -n "$name" ] || return 0
			case "$name" in *".$suffix") [ -n "$suffix" ] && return 0 ;; esac
			domains="$domains $name"
		}
		config_foreach _vn_rebind_node node
	fi

	want=''
	for d in $domains; do want="${want}rebind-domain-ok=/$d/
"; done

	for conf in /var/etc/dnsmasq.conf.*; do
		[ -e "$conf" ] || continue
		dir=$(sed -n 's/^conf-dir=\([^,]*\).*/\1/p' "$conf" | head -1)
		[ -d "$dir" ] || continue
		file=$dir/tailscale-vnode.conf
		if [ -n "$want" ]; then
			printf '%s' "$want" > "$file.new"
			if cmp -s "$file.new" "$file"; then
				rm -f "$file.new"
			else
				mv -f "$file.new" "$file"
				changed=1
			fi
		elif [ -e "$file" ]; then
			rm -f "$file"
			changed=1
		fi
	done

	if [ $changed = 1 ]; then
		vn_log "DNS rebind exceptions changed (${domains:-none}), restarting dnsmasq"
		/etc/init.d/dnsmasq restart >/dev/null 2>&1
	fi
}
