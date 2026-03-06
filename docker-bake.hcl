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
  targets = ["attestation", "topup", "deploy", "contract", "smoke"]
}

group "services" {
  targets = ["attestation", "topup", "deploy"]
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
  args       = { PACKAGE_DIR = "services/attestation" }
  platforms  = PLATFORMS
}

target "topup-base" {
  context    = "."
  dockerfile = "services/Dockerfile.common"
  target     = "runtime"
  args       = { PACKAGE_DIR = "services/topup" }
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

target "deploy-base" {
  context    = "."
  dockerfile = "services/Dockerfile.common"
  target     = "runtime"
  args       = { PACKAGE_DIR = "contract-deployment" }
  platforms  = PLATFORMS
}

target "deps" {
  context    = "."
  dockerfile = "services/Dockerfile.common"
  target     = "deps"
  platforms  = PLATFORMS
}

target "contract" {
  context    = "."
  dockerfile = "scripts/contract/Dockerfile.contract"
  platforms  = ["linux/amd64"]
  tags = compact([
    "${REGISTRY}nethermind/aztec-fpc-contract-artifact:${TAG}${PLATFORM_SUFFIX}",
    GIT_SHA != "" ? "${REGISTRY}nethermind/aztec-fpc-contract-artifact:${GIT_SHA}${PLATFORM_SUFFIX}" : "",
  ])
}

target "deploy" {
  inherits   = ["_labels"]
  context    = "."
  dockerfile = "scripts/contract/Dockerfile.deploy"
  contexts   = {
    common   = "target:deploy-base"
    contract = "target:contract"
  }
  platforms  = PLATFORMS
  tags = compact([
    "${REGISTRY}nethermind/aztec-fpc-contract-deployment:${TAG}${PLATFORM_SUFFIX}",
    GIT_SHA != "" ? "${REGISTRY}nethermind/aztec-fpc-contract-deployment:${GIT_SHA}${PLATFORM_SUFFIX}" : "",
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
