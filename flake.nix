{
  description = "Vendure MCP server - CLI integration for Vendure e-commerce";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f {
        pkgs = nixpkgs.legacyPackages.${system};
        inherit system;
      });
    in
    {
      packages = forAllSystems ({ pkgs, ... }: {
        default = pkgs.buildNpmPackage rec {
          pname = "vendure-mcp-server";
          version = "1.0.4-alpha";

          src = ./.;

          npmDepsHash = "sha256-WkhWeK55FLTGpI20Yf7xe5Xogp9PT/rsL3xbeP1wfUQ=";

          npmBuildScript = "build";
          doCheck = false;

          meta = {
            description = "Official Vendure MCP server for CLI integration";
            homepage = "https://github.com/vendure-ecommerce/mcp";
            license = pkgs.lib.licenses.mit;
            mainProgram = "vendure-mcp";
          };
        };
      });
    };
}
