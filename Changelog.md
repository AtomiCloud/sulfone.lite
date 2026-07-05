## [4.7.0](https://github.com/AtomiCloud/sulfone.lite/compare/v4.6.0...v4.7.0) (2026-07-05)


### ✨ Features ✨

* **probe:** contract, feature declaration, publish surface, fixtures ([f6decb0](https://github.com/AtomiCloud/sulfone.lite/commit/f6decb0dbb05ba7aee4ee544d8ffe7bad56559e3))
* **probe:** engine — sandbox, matrix, resolution, manifest, built-ins ([52656dd](https://github.com/AtomiCloud/sulfone.lite/commit/52656dd3163f28e9fc904c7422e7fecec381d6e7))
* **probe:** surface — command, test-flow tier, skill, meta-template ([1974c77](https://github.com/AtomiCloud/sulfone.lite/commit/1974c7786d615f1616b56dad748f9b5f64ebb55f))


### 🐛 Bug Fixes 🐛

* **probe:** address CodeRabbit review findings on PR [#8](https://github.com/AtomiCloud/sulfone.lite/issues/8) ([3e8c764](https://github.com/AtomiCloud/sulfone.lite/commit/3e8c7642d22b9dacfbd383b7da986652ee4958dd))

## [4.6.0](https://github.com/AtomiCloud/sulfone.lite/compare/v4.5.0...v4.6.0) (2026-07-03)


### ✨ Features ✨

* **core:** static composition, global resolvers, git-merge update ([36e5d1f](https://github.com/AtomiCloud/sulfone.lite/commit/36e5d1ffdbd01bddf2985da3cb217cbe682e2d22))


### 🐛 Bug Fixes 🐛

* **test:** keep artifact test fixtures byte-exact under treefmt ([593672b](https://github.com/AtomiCloud/sulfone.lite/commit/593672b865743dd5ddf60c1a9f9e5c54ef1ba1dc))

## [4.5.0](https://github.com/AtomiCloud/sulfone.lite/compare/v4.4.0...v4.5.0) (2026-07-02)


### ✨ Features ✨

* **lite:** backdrop placeholders and defaults-based re-runs ([6f03aa7](https://github.com/AtomiCloud/sulfone.lite/commit/6f03aa7ec6e12280832b0b509df92ca865566dd5))
* **lite:** prefill placeholders and carry answers across re-runs ([3403409](https://github.com/AtomiCloud/sulfone.lite/commit/34034096ced13f342291ac51d2b0f5f8886376af))
* **lite:** render prompt descriptions at the bottom of list prompts ([ce11e7a](https://github.com/AtomiCloud/sulfone.lite/commit/ce11e7a2e5d3c707cc9f4b6da9ea56b56eae9d0f))


### 🐛 Bug Fixes 🐛

* **lite:** guard re-run suggestions and correct prompt docs ([b03f024](https://github.com/AtomiCloud/sulfone.lite/commit/b03f024f20d8fabfdde36ada5343196c7dd53f3a))

## [4.4.0](https://github.com/AtomiCloud/sulfone.lite/compare/v4.3.0...v4.4.0) (2026-07-02)


### ✨ Features ✨

* **lite:** render prompt descriptions below the input ([7c88ef9](https://github.com/AtomiCloud/sulfone.lite/commit/7c88ef90c4c9c0da5480efc6a4456329ecf2ec3a))


### 🐛 Bug Fixes 🐛

* **lite:** sync bun.lock with release version bumps ([da93621](https://github.com/AtomiCloud/sulfone.lite/commit/da9362110b6120e4efc6ca9166ea24d9a1ea00bb))

## [4.3.0](https://github.com/AtomiCloud/sulfone.lite/compare/v4.2.0...v4.3.0) (2026-07-02)


### ✨ Features ✨

* **lite:** compile cyanprint in nix and bundle source artifacts ([2fcbc4d](https://github.com/AtomiCloud/sulfone.lite/commit/2fcbc4d936ff19bf458af13d773e3b578de07638))
* **lite:** prompt placeholders, descriptions, and option help ([6c974a2](https://github.com/AtomiCloud/sulfone.lite/commit/6c974a28ee5a35b50d2d6deea2f1bea760bdb53b))


### 🐛 Bug Fixes 🐛

* **lite:** bump package.json version on release ([d36881f](https://github.com/AtomiCloud/sulfone.lite/commit/d36881fd1eb6ff9c527b571f55c5fdde9056b465))
* **lite:** guide trace users when a project template cannot resolve ([ca2a663](https://github.com/AtomiCloud/sulfone.lite/commit/ca2a663fbd99755727ab4bcd231c54a0206bb335))
* **lite:** harden source runtime bundle materialization ([9531151](https://github.com/AtomiCloud/sulfone.lite/commit/9531151d824c63e1e989ba57d177ee3503016780))
* **lite:** include lock files in the source runtime cache key ([d26ba3b](https://github.com/AtomiCloud/sulfone.lite/commit/d26ba3bfbe1ce215bf16560bfffddb26d9613f88))

## [4.2.0](https://github.com/AtomiCloud/sulfone.lite/compare/v4.1.0...v4.2.0) (2026-07-02)


### ✨ Features ✨

* **lite:** prompt validation, progress steps, project trace ([e7d2149](https://github.com/AtomiCloud/sulfone.lite/commit/e7d2149b5fa4154cf0280605bcfde2154a57b319))


### 🐛 Bug Fixes 🐛

* **lite:** exclude e2e fixture archives from treefmt ([1365c10](https://github.com/AtomiCloud/sulfone.lite/commit/1365c10464242b339fc748c10056b29b6084707e))


### 🧪 Tests 🧪

* **lite:** add parity matrix rows for presets, uniqueness, and trace ([f920e7c](https://github.com/AtomiCloud/sulfone.lite/commit/f920e7ca3f9cc46d3e0a14ff961cd8476404ab44))
* **lite:** run all 39 parity cases as real e2e tests ([67a9663](https://github.com/AtomiCloud/sulfone.lite/commit/67a966321f6a5b834bf91a90206163e5cc3138d2))

## [4.1.0](https://github.com/AtomiCloud/sulfone.lite/compare/v4.0.1...v4.1.0) (2026-07-02)


### 📜 Documentation 📜

* **lite:** deepen official artifact skills ([6591ae5](https://github.com/AtomiCloud/sulfone.lite/commit/6591ae5a7328bdaecd20f3c362b73ee1c77a926f))


### ✨ Features ✨

* **lite:** composition features, registry hardening, readable e2e ([08ab6ce](https://github.com/AtomiCloud/sulfone.lite/commit/08ab6ce3e040f73c760aac44ef6be30193d2ad6a))
* **lite:** stabilize auth and official artifacts ([b990397](https://github.com/AtomiCloud/sulfone.lite/commit/b990397b7a7c081f3d6d68e707b2e63160c216c2))


### 🐛 Bug Fixes 🐛

* **lite:** build seed archive from clean template tree ([9eb3032](https://github.com/AtomiCloud/sulfone.lite/commit/9eb3032e39fae923a3dc454579d79fb94a1ecb41))
* **lite:** resync meta template fixtures and seed after formatting ([1fc0989](https://github.com/AtomiCloud/sulfone.lite/commit/1fc09891387a60d656cf618fc28a3025943a76e7))


### 🧪 Tests 🧪

* **lite:** make artifact validations command based ([0f5d147](https://github.com/AtomiCloud/sulfone.lite/commit/0f5d147ecff5e668977264ba7106a0b6955a42b7))

## [4.0.1](https://github.com/AtomiCloud/sulfone.lite/compare/v4.0.0...v4.0.1) (2026-06-29)


### 🐛 Bug Fixes 🐛

* **no-release:** correct v4 changelog ([2ba48d2](https://github.com/AtomiCloud/sulfone.lite/commit/2ba48d2d2f5228aa1e67a4aaea8f6ef200985464))
* **no-release:** prevent opennext hijacking registry deploy ([9310afc](https://github.com/AtomiCloud/sulfone.lite/commit/9310afc8ed02817bd205b8d65d3b96aff5c5be27))
* secure production registry seeds ([b8c9362](https://github.com/AtomiCloud/sulfone.lite/commit/b8c9362d96d4b3c0f920b90701ede5898bc36b33))

## [4.0.0](https://github.com/AtomiCloud/sulfone.lite/releases/tag/v4.0.0) (2026-06-29)

### Features

* add cyanprint v4 lite runtime ([92dbe15](https://github.com/AtomiCloud/sulfone.lite/commit/92dbe15d712fb57fce49d3668b3e9a4b6724a758))
* wire cloudflare deploy and package publishing ([eed8b6a](https://github.com/AtomiCloud/sulfone.lite/commit/eed8b6aa8bc27fc922bdb0795c6d50f101a29d46))

### Documentation

* add developer standards and skills ([c9f6e08](https://github.com/AtomiCloud/sulfone.lite/commit/c9f6e085aaf9e17c27ecc3a8c4abb446aebd4624))
* add typescript quality standard ([2345155](https://github.com/AtomiCloud/sulfone.lite/commit/234515543a4116a021a28998e93a4dea8e851184))
