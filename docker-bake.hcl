variable "REGISTRY" {
  default = ""
}

variable "TAG" {
  default = "local"
}

variable "GIT_SHA" {
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
}

target "topup-base" {
  context    = "."
  dockerfile = "services/Dockerfile.common"
  target     = "runtime"
  args       = { SERVICE = "topup" }
}

target "attestation" {
  inherits   = ["_labels"]
  context    = "."
  dockerfile = "services/attestation/Dockerfile"
  contexts   = { common = "target:attestation-base" }
  tags = compact([
    "${REGISTRY}nethermind/aztec-fpc-attestation:${TAG}",
    GIT_SHA != "" ? "${REGISTRY}nethermind/aztec-fpc-attestation:${GIT_SHA}" : "",
  ])
}

target "topup" {
  inherits   = ["_labels"]
  context    = "."
  dockerfile = "services/topup/Dockerfile"
  contexts   = { common = "target:topup-base" }
  tags = compact([
    "${REGISTRY}nethermind/aztec-fpc-topup:${TAG}",
    GIT_SHA != "" ? "${REGISTRY}nethermind/aztec-fpc-topup:${GIT_SHA}" : "",
  ])
}
