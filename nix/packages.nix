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
  cyanprint = pkgs.writeShellApplication {
    name = "cyanprint";
    runtimeInputs = [
      tools.bun
      pkgs.coreutils
    ];
    text = ''
      cache_base="''${XDG_CACHE_HOME:-''${HOME:-/tmp}/.cache}/cyanprint/nix-app"
      source_dir="$cache_base/source"
      source_marker="$cache_base/source.sha256"
      source_store="${../.}"
      expected_lock="${builtins.hashFile "sha256" ../bun.lock}"
      expected_source="$source_store:$expected_lock"

      if [ ! -f "$source_marker" ] || [ "$(cat "$source_marker")" != "$expected_source" ]; then
        rm -rf "$source_dir"
        mkdir -p "$cache_base"
        cp -R "$source_store" "$source_dir"
        chmod -R u+w "$source_dir"
        bun install --cwd "$source_dir" --frozen-lockfile
        printf '%s' "$expected_source" > "$source_marker"
      fi

      exec bun run --cwd "$source_dir" packages/cli/src/main.ts "$@"
    '';
  };
in
tools
// {
  inherit cyanprint;
  default = cyanprint;
}
