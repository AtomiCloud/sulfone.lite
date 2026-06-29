# Install CyanPrint v4

## Homebrew

```bash
brew tap cyanprint/homebrew-tap
brew install --cask cyanprint
```

## Scoop

```bash
scoop bucket add cyanprint https://github.com/cyanprint/scoop-bucket
scoop install cyanprint
```

## Nix

```bash
nix profile install github:cyanprint/cyanprint#cyanprint
```

## apt/deb

Download the `.deb` release artifact, then install it locally:

```bash
sudo apt install ./cyanprint_*_amd64.deb
```

## yum/rpm

Download the `.rpm` release artifact, then install it locally:

```bash
sudo yum install ./cyanprint-*.x86_64.rpm
```

## apk

Download the `.apk` release artifact, then install it locally:

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
