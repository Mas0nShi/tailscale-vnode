# SPDX-License-Identifier: GPL-2.0-only

include $(TOPDIR)/rules.mk

PKG_VERSION:=0.1.0
PKG_RELEASE:=1
PKG_MAINTAINER:=Mas0nShi
PKG_LICENSE:=GPL-2.0-only

LUCI_TITLE:=LuCI pages for tailscale-vnode
LUCI_DEPENDS:=+tailscale-vnode +luci-base
LUCI_PKGARCH:=all

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
