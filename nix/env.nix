{ pkgs, packages }:
with packages;
{
  dev = [
    git
    pls
  ];

  lint = [
    actionlint
    bun
    gitlint
    go-task
    pre-commit
    sg
    shellcheck
    treefmt
  ];

  main = [
  ];

  releaser = [
    sg
  ];

  system = [
    atomiutils
  ];
}
