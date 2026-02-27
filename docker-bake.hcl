variable "REGISTRY" {
  default = ""
}

variable "TAG" {
  default = "latest"
}

variable "GIT_SHA" {
  default = ""
}

variable "PLATFORM_SUFFIX" {
  default = ""
}

group "default" {
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
  platforms  = ["linux/amd64", "linux/arm64"]
}

target "topup-base" {
  context    = "."
  dockerfile = "services/Dockerfile.common"
  target     = "runtime"
  args       = { SERVICE = "topup" }
  platforms  = ["linux/amd64", "linux/arm64"]
}

target "attestation" {
  inherits   = ["_labels"]
  context    = "."
  dockerfile = "services/attestation/Dockerfile"
  contexts   = { common = "target:attestation-base" }
  platforms  = ["linux/amd64", "linux/arm64"]
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
  platforms  = ["linux/amd64", "linux/arm64"]
  tags = compact([
    "${REGISTRY}nethermind/aztec-fpc-topup:${TAG}${PLATFORM_SUFFIX}",
    GIT_SHA != "" ? "${REGISTRY}nethermind/aztec-fpc-topup:${GIT_SHA}${PLATFORM_SUFFIX}" : "",
  ])
}
