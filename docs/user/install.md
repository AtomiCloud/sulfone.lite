# Install CyanPrint v4

## Homebrew

```bash
brew tap AtomiCloud/homebrew-tap
brew install --cask cyanprint
```

## Scoop

```bash
scoop bucket add atomicloud https://github.com/AtomiCloud/scoop-bucket
scoop install cyanprint
```

## Nix

```bash
nix profile install github:AtomiCloud/sulfone.lite#cyanprint
```

## apt/deb

Install from the AtomiCloud Gemfury apt repository, or download the `.deb` release artifact and install it locally:

```bash
sudo apt install ./cyanprint_*_amd64.deb
```

## yum/rpm

Install from the AtomiCloud Gemfury yum repository, or download the `.rpm` release artifact and install it locally:

```bash
sudo yum install ./cyanprint-*.x86_64.rpm
```

## apk

Install from the AtomiCloud Gemfury apk repository, or download the `.apk` release artifact and install it locally:

```bash
sudo apk add --allow-untrusted ./cyanprint_*.apk
```

## arch/pacman

Download the Arch package release artifact, then install it locally:

```bash
sudo pacman -U ./cyanprint-*.pkg.tar.zst
```

## Direct archive

Download the release archive for your platform and place `cyanprint` on PATH.

## Source/Bun development

```bash
bun install
bun run cyan -- --version
```
