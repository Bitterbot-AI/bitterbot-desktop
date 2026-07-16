# PLAN-36 Phase 1: circles mailbox host — one small DO droplet running the
# standalone mailbox host behind Caddy TLS at var.hostname. Separate state from
# the relay fleet so it can be created/destroyed independently and never touches
# the network-backbone relays. DNS (the A record) is set by dns.sh via the
# Cloudflare API, mirroring the fleet's curl-based DNS pattern.
terraform {
  required_version = ">= 1.5"
  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "~> 2.40"
    }
  }
}

provider "digitalocean" {
  # Reads DIGITALOCEAN_TOKEN from env.
}

variable "hostname" {
  description = "Public FQDN clients dial (must match circles.mailbox.url)."
  type        = string
  default     = "mailbox.bitterbot.ai"
}

variable "join_hostname" {
  description = "Public FQDN for the static guest-JOIN page (PLAN-36 §4)."
  type        = string
  default     = "join.bitterbot.ai"
}

variable "region" {
  description = "DO region. Central-ish keeps latency reasonable worldwide."
  type        = string
  default     = "nyc1"
}

variable "droplet_size" {
  description = "s-1vcpu-1gb ($6/mo) is ample for a metadata-only sealed relay."
  type        = string
  default     = "s-1vcpu-1gb"
}

variable "image" {
  type    = string
  default = "debian-13-x64"
}

# Reuse the existing fleet admin key (registered by the relay-fleet config) so
# we don't duplicate the key on the DO account.
data "digitalocean_ssh_key" "fleet" {
  name = "bitterbot-relay-fleet"
}

resource "digitalocean_droplet" "mailbox" {
  name       = "bitterbot-mailbox"
  region     = var.region
  size       = var.droplet_size
  image      = var.image
  ssh_keys   = [data.digitalocean_ssh_key.fleet.id]
  ipv6       = true
  monitoring = true
  tags       = ["bitterbot", "circles-mailbox"]
  user_data = templatefile("${path.module}/cloud-init.yaml", {
    fqdn      = var.hostname
    join_fqdn = var.join_hostname
  })
}

resource "digitalocean_firewall" "mailbox" {
  name        = "bitterbot-mailbox"
  droplet_ids = [digitalocean_droplet.mailbox.id]

  inbound_rule {
    protocol         = "tcp"
    port_range       = "22"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }
  inbound_rule {
    protocol         = "tcp"
    port_range       = "80"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }
  inbound_rule {
    protocol         = "tcp"
    port_range       = "443"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }
  outbound_rule {
    protocol              = "tcp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
  outbound_rule {
    protocol              = "udp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
}

output "ipv4" {
  value = digitalocean_droplet.mailbox.ipv4_address
}

output "hostname" {
  value = var.hostname
}

output "join_hostname" {
  value = var.join_hostname
}
