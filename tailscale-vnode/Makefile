# SPDX-License-Identifier: GPL-2.0-only

include $(TOPDIR)/rules.mk

PKG_NAME:=tailscale-vnode
PKG_VERSION:=0.1.0
PKG_RELEASE:=1

PKG_MAINTAINER:=Mas0nShi
PKG_LICENSE:=GPL-2.0-only

include $(INCLUDE_DIR)/package.mk

define Package/tailscale-vnode
  SECTION:=net
  CATEGORY:=Network
  SUBMENU:=VPN
  TITLE:=Expose LAN hosts as their own Tailscale nodes
  DEPENDS:=+tailscale +ip-full +kmod-veth +kmod-nft-nat +kmod-nft-fib +jsonfilter +curl
  PKGARCH:=all
endef

define Package/tailscale-vnode/description
  Runs one tailscaled per configured LAN host, each in its own network
  namespace, and forwards everything sent to that node's Tailscale address
  to the host. LAN hosts get their own Tailscale name and address without
  installing Tailscale and without subnet routes on the clients.
endef

define Package/tailscale-vnode/conffiles
/etc/config/tailscale-vnode
endef

define Build/Compile
endef

define Package/tailscale-vnode/install
	$(INSTALL_DIR) $(1)/etc/config $(1)/etc/init.d $(1)/etc/hotplug.d/dhcp $(1)/usr/sbin \
		$(1)/usr/lib/tailscale-vnode $(1)/lib/upgrade/keep.d \
		$(1)/usr/share/nftables.d/chain-pre/forward \
		$(1)/usr/share/nftables.d/chain-pre/input
	$(INSTALL_CONF) ./files/tailscale-vnode.config $(1)/etc/config/tailscale-vnode
	$(INSTALL_BIN) ./files/tailscale-vnode.init $(1)/etc/init.d/tailscale-vnode
	$(INSTALL_BIN) ./files/tailscale-vnode.cli $(1)/usr/sbin/tailscale-vnode
	$(INSTALL_DATA) ./files/tailscale-vnode.hotplug-dhcp $(1)/etc/hotplug.d/dhcp/50-tailscale-vnode
	$(INSTALL_DATA) ./files/vnode.sh $(1)/usr/lib/tailscale-vnode/vnode.sh
	$(INSTALL_DATA) ./files/dns.sh $(1)/usr/lib/tailscale-vnode/dns.sh
	$(INSTALL_BIN) ./files/tailscaled-vnode $(1)/usr/lib/tailscale-vnode/tailscaled-vnode
	$(INSTALL_DATA) ./files/tailscale-vnode.upgrade $(1)/lib/upgrade/keep.d/tailscale-vnode
	$(INSTALL_DATA) ./files/fw4-forward.nft \
		$(1)/usr/share/nftables.d/chain-pre/forward/30-tailscale-vnode.nft
	$(INSTALL_DATA) ./files/fw4-input.nft \
		$(1)/usr/share/nftables.d/chain-pre/input/30-tailscale-vnode.nft
endef

# fw4 only reads nftables.d fragments when it (re)builds its ruleset, and
# dnsmasq only passes leases to /etc/hotplug.d/dhcp if a handler existed when
# it started.
define Package/tailscale-vnode/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	fw4 -q reload
	/etc/init.d/dnsmasq restart
}
exit 0
endef

define Package/tailscale-vnode/postrm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	rm -f /tmp/dnsmasq*.d/tailscale-vnode.conf
	fw4 -q reload
	/etc/init.d/dnsmasq restart
}
exit 0
endef

$(eval $(call BuildPackage,tailscale-vnode))
