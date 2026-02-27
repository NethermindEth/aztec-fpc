variable "REGISTRY" {
  default = ""
}

variable "TAG" {
  default = "local"
}

variable "GIT_SHA" {
  default = ""
}

variable "PLATFORMS" {
  default = []
  type = list(string)
}

variable "PLATFORM_SUFFIX" {
  default = ""
}

group "default" {
  targets = ["attestation", "topup", "deploy", "smoke"]
}

group "services" {
  targets = ["attestation", "topup"]
}

target "_labels" {
  labels = {
    "org.opencontainers.image.source"   = "https://github.com/nethermind/aztec-fpc"
    "org.opencontainers.image.revision" = "${GIT_SHA}"
  }
}

target "attestation-base" {
  context    = "."
  dockerfile = "services/Dockerfile.common"
  target     = "runtime"
  args       = { SERVICE = "attestation" }
  platforms  = PLATFORMS
}

target "topup-base" {
  context    = "."
  dockerfile = "services/Dockerfile.common"
  target     = "runtime"
  args       = { SERVICE = "topup" }
  platforms  = PLATFORMS
}

target "attestation" {
  inherits   = ["_labels"]
  context    = "."
  dockerfile = "services/attestation/Dockerfile"
  contexts   = { common = "target:attestation-base" }
  platforms  = PLATFORMS
  tags = compact([
    "${REGISTRY}nethermind/aztec-fpc-attestation:${TAG}${PLATFORM_SUFFIX}",
    GIT_SHA != "" ? "${REGISTRY}nethermind/aztec-fpc-attestation:${GIT_SHA}${PLATFORM_SUFFIX}" : "",
  ])
}

target "topup" {
  inherits   = ["_labels"]
  context    = "."
  dockerfile = "services/topup/Dockerfile"
  contexts   = { common = "target:topup-base" }
  platforms  = PLATFORMS
  tags = compact([
    "${REGISTRY}nethermind/aztec-fpc-topup:${TAG}${PLATFORM_SUFFIX}",
    GIT_SHA != "" ? "${REGISTRY}nethermind/aztec-fpc-topup:${GIT_SHA}${PLATFORM_SUFFIX}" : "",
  ])
}

target "deps" {
  context    = "."
  dockerfile = "services/Dockerfile.common"
  target     = "deps"
  platforms  = PLATFORMS
}

target "deploy" {
  inherits   = ["_labels"]
  context    = "."
  dockerfile = "scripts/contract/Dockerfile.deploy"
  contexts   = { deps = "target:deps" }
  platforms  = PLATFORMS
  target     = "deploy"
  tags = compact([
    "${REGISTRY}nethermind/aztec-fpc-deploy:${TAG}${PLATFORM_SUFFIX}",
    GIT_SHA != "" ? "${REGISTRY}nethermind/aztec-fpc-deploy:${GIT_SHA}${PLATFORM_SUFFIX}" : "",
  ])
}

target "smoke" {
  inherits   = ["_labels"]
  context    = "."
  dockerfile = "Dockerfile.smoke"
  contexts   = {
    common = "target:deps"
    deploy = "target:deploy"
  }
  platforms  = PLATFORMS
  tags = compact([
    "${REGISTRY}nethermind/aztec-fpc-smoke:${TAG}${PLATFORM_SUFFIX}",
    GIT_SHA != "" ? "${REGISTRY}nethermind/aztec-fpc-smoke:${GIT_SHA}${PLATFORM_SUFFIX}" : "",
  ])
}
