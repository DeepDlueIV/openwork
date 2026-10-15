terraform {
  required_version = ">= 1.11, < 2.0"

  required_providers {
    aws = {
      source = "hashicorp/aws"
      # Compatibility exception: the managed installer pins 5.100; 6.x is
      # live-tested. A single ~> range cannot preserve both supported majors.
      version = ">= 5.100, < 7.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.7, >= 3.7.2"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.7"
    }
    http = {
      source  = "hashicorp/http"
      version = "~> 3.5"
    }
  }
}
