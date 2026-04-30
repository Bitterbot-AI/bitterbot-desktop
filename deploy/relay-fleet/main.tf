# Bitterbot relay-fleet — Terraform module for DigitalOcean
#
# Provisions a 3-region fleet (NYC1 / FRA1 / SGP1) of always-on libp2p
# relay+bootstrap nodes. Each runs the Bitterbot orchestrator daemon in
# `--relay-mode server --node-tier management --bootnode-mode` so it serves
# both as a Kademlia bootstrap entry AND as a Circuit Relay v2 hop for
# NAT'd edge nodes.
#
# Required env vars:
#   - DIGITALOCEAN_TOKEN  Personal Access Token (read+write) from
#                         https://cloud.digitalocean.com/account/api/tokens
#
# After `terraform apply`, capture the peer IDs from each droplet's first
# boot log and feed them to scripts/update-dnsaddr.sh to publish under
# `_dnsaddr.p2p.bitterbot.ai`.

terraform {
  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "~> 2.40"
    }
  }
}

provider "digitalocean" {
  # Reads DIGITALOCEAN_TOKEN from env automatically.
}

variable "regions" {
  description = "DigitalOcean region slugs to deploy a relay node into. Three is the recommended minimum for global coverage."
  type        = list(string)
  default     = ["nyc1", "fra1", "sgp1"]
}

variable "droplet_size" {
  description = "DO droplet size slug. s-1vcpu-1gb ($6/mo, 25GB SSD, 1TB egress) is sufficient for a relay handling hundreds of peers."
  type        = string
  default     = "s-1vcpu-1gb"
}

variable "image" {
  description = "Base image. Debian 12 keeps cloud-init simple and apt up to date."
  type        = string
  default     = "debian-12-x64"
}

variable "ssh_pubkey_path" {
  description = "Path to the SSH public key used to admin the fleet. Generate with `ssh-keygen -t ed25519 -f ~/.ssh/bitterbot-relay -C bitterbot-relay-fleet`."
  type        = string
  default     = "~/.ssh/bitterbot-relay.pub"
}

variable "git_repo_url" {
  description = "Git repo to clone on each droplet. Must contain orchestrator/ at the root."
  type        = string
  default     = "https://github.com/Bitterbot-AI/bitterbot-desktop.git"
}

variable "git_branch" {
  description = "Branch to build from. Pin to a tag in production."
  type        = string
  default     = "main"
}

variable "genesis_trust_list_url" {
  description = "URL of the genesis trust list these relays should bootstrap with. Each relay's pubkey gets added to this list automatically AFTER first boot via the post-provision step."
  type        = string
  default     = ""
}

resource "digitalocean_ssh_key" "fleet" {
  name       = "bitterbot-relay-fleet"
  public_key = file(pathexpand(var.ssh_pubkey_path))
}

# Single firewall used by every droplet in the fleet. Inbound: SSH from
# anywhere (replace with your IP CIDR for tighter ops), libp2p TCP/9100,
# Bitterbot HTTP API on 9847 (loopback only via systemd unit), and reserved
# ports for future WSS (443) and QUIC (9101 UDP) listeners.
resource "digitalocean_firewall" "fleet" {
  name        = "bitterbot-relay-fleet"
  droplet_ids = [for d in digitalocean_droplet.relay : d.id]

  inbound_rule {
    protocol         = "tcp"
    port_range       = "22"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }
  inbound_rule {
    protocol         = "tcp"
    port_range       = "9100"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }
  inbound_rule {
    protocol         = "tcp"
    port_range       = "443"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }
  inbound_rule {
    protocol         = "udp"
    port_range       = "9101"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }
  inbound_rule {
    protocol         = "icmp"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }

  outbound_rule {
    protocol              = "tcp"
    port_range            = "all"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
  outbound_rule {
    protocol              = "udp"
    port_range            = "all"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
  outbound_rule {
    protocol              = "icmp"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
}

resource "digitalocean_droplet" "relay" {
  for_each = toset(var.regions)

  name       = "bitterbot-relay-${each.value}"
  region     = each.value
  size       = var.droplet_size
  image      = var.image
  ssh_keys   = [digitalocean_ssh_key.fleet.id]
  ipv6       = true
  monitoring = true

  user_data = templatefile("${path.module}/cloud-init.yaml", {
    git_repo_url           = var.git_repo_url
    git_branch             = var.git_branch
    genesis_trust_list_url = var.genesis_trust_list_url
  })

  tags = ["bitterbot", "relay", "node-tier-management"]
}

output "relay_ipv4" {
  description = "Public IPv4 of each relay, keyed by region."
  value       = { for region, d in digitalocean_droplet.relay : region => d.ipv4_address }
}

output "relay_ipv6" {
  description = "Public IPv6 of each relay, keyed by region."
  value       = { for region, d in digitalocean_droplet.relay : region => d.ipv6_address }
}

output "next_steps" {
  description = "Commands to run after provisioning."
  value       = <<-EOT
    1. Wait ~10 min for cloud-init to finish (Rust build is the long pole on a 1GB droplet).
    2. Capture peer IDs:
        for region in ${join(" ", var.regions)}; do
          ip=$(terraform output -json relay_ipv4 | jq -r ".[\"$region\"]")
          peer_id=$(ssh -i ~/.ssh/bitterbot-relay -o StrictHostKeyChecking=accept-new \
                    root@$ip 'cat /var/lib/bitterbot/peer-id.txt')
          echo "$region $ip $peer_id"
        done
    3. Publish dnsaddr TXT records:
        ./scripts/update-dnsaddr.sh
    4. Add each relay's pubkey to genesis-trust.txt and commit (so they pass
       the management-tier startup check on next restart).
  EOT
}
