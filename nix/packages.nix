{
  atomi,
  pkgs,
  pkgs-2605,
  pkgs-unstable,
}:
let
  all = rec {
    atomipkgs = (
      with atomi;
      {
        inherit
          atomiutils
          pls
          sg
          ;
      }
    );

    nix-2605 = (
      with pkgs-2605;
      {
        inherit
          actionlint
          git
          gitlint
          goreleaser
          go-task
          infisical
          pnpm
          pre-commit
          shellcheck
          treefmt
          ;
      }
    );

    nix-unstable = (
      with pkgs-unstable;
      {
        inherit
          bun
          ;
      }
    );
  };
in
with all;
let
  tools = atomipkgs // nix-2605 // nix-unstable;
  # Runtime dependencies for the CLI, installed as a fixed-output derivation so the
  # compile step below stays pure and offline. Dev and optional dependencies are
  # omitted: they carry platform-specific binaries (workerd, swc) the CLI never needs,
  # and skipping them keeps the output identical across systems.
  cyanprint-node-modules = pkgs.stdenvNoCC.mkDerivation {
    pname = "cyanprint-node-modules";
    version = "0";
    src = ../.;
    nativeBuildInputs = [
      tools.bun
      pkgs.cacert
    ];
    dontPatch = true;
    dontConfigure = true;
    dontFixup = true;
    buildPhase = ''
      export HOME="$TMPDIR"
      bun install --frozen-lockfile --production --omit=optional --ignore-scripts --no-progress
    '';
    # Production installs nest each workspace's dependencies under
    # packages/*/node_modules — capture every node_modules dir, preserving layout.
    installPhase = ''
      mkdir -p "$out"
      find . -maxdepth 3 -type d -name node_modules | while read -r dir; do
        mkdir -p "$out/$(dirname "$dir")"
        cp -R "$dir" "$out/$dir"
      done
    '';
    outputHashAlgo = "sha256";
    outputHashMode = "recursive";
    outputHash = "sha256-s2gY2RdXCvJTaE2EHauq1ZwwgASY0lhFA6siXLAJzZI=";
  };
  # Compile the CLI into a single self-contained binary (bun embeds its runtime),
  # matching the artifact GoReleaser ships for Homebrew/Scoop/nfpm.
  cyanprint = pkgs.stdenvNoCC.mkDerivation {
    pname = "cyanprint";
    version = "4";
    src = ../.;
    nativeBuildInputs = [ tools.bun ];
    dontPatch = true;
    dontConfigure = true;
    dontFixup = true;
    buildPhase = ''
      export HOME="$TMPDIR"
      cp -R ${cyanprint-node-modules}/. .
      find . -maxdepth 3 -type d -name node_modules -exec chmod -R u+w {} +
      bun build packages/cli/src/main.ts --compile --outfile cyanprint
    '';
    installPhase = ''
      install -Dm755 cyanprint "$out/bin/cyanprint"
    '';
  };
in
tools
// {
  inherit cyanprint;
  default = cyanprint;
}
