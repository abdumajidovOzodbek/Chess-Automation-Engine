{pkgs}: {
  deps = [
    pkgs.alsa-lib
    pkgs.libxkbcommon
    pkgs.xorg.libxcb
    pkgs.mesa
    pkgs.xorg.libXrandr
    pkgs.xorg.libXfixes
    pkgs.xorg.libXext
    pkgs.xorg.libXdamage
    pkgs.xorg.libXcomposite
    pkgs.xorg.libX11
    pkgs.dbus
    pkgs.at-spi2-core
    pkgs.at-spi2-atk
    pkgs.nspr
    pkgs.nss
    pkgs.glib
  ];
}
