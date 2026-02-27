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
}

variable "PLATFORM_SUFFIX" {
  default = ""
}

group "default" {
  targets = ["attestation", "topup", "contract-compile", "contract-deploy"]
}

group "contract" {
  targets = ["contract-compile", "contract-deploy"]
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

target "contract-compile" {
  inherits   = ["_labels"]
  context    = "."
  dockerfile = "scripts/contract/Dockerfile.deploy"
  platforms  = PLATFORMS
  target     = "compile"
  tags = compact([
    "${REGISTRY}nethermind/aztec-fpc-contract-compile:${TAG}${PLATFORM_SUFFIX}",
    GIT_SHA != "" ? "${REGISTRY}nethermind/aztec-fpc-contract-compile:${GIT_SHA}${PLATFORM_SUFFIX}" : "",
  ])
}

target "contract-deploy" {
  inherits   = ["_labels"]
  context    = "."
  dockerfile = "scripts/contract/Dockerfile.deploy"
  platforms  = PLATFORMS
  target     = "deploy"
  tags = compact([
    "${REGISTRY}nethermind/aztec-fpc-contract-deploy:${TAG}${PLATFORM_SUFFIX}",
    GIT_SHA != "" ? "${REGISTRY}nethermind/aztec-fpc-contract-deploy:${GIT_SHA}${PLATFORM_SUFFIX}" : "",
  ])
}
