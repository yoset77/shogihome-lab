import os from "os";

// Function to get local private IP addresses (including Tailscale/VPN)
export const getLocalIpAddresses = (networkInterfaces = os.networkInterfaces()): string[] => {
  const addresses: string[] = [];
  let hasStandardPrivate = false;
  const cgnatCandidates: string[] = [];

  for (const name of Object.keys(networkInterfaces)) {
    for (const iface of networkInterfaces[name]!) {
      // Skip internal (localhost) and non-IPv4 addresses
      if (iface.family !== "IPv4" || iface.internal) {
        continue;
      }

      const parts = iface.address.split(".").map(Number);

      const isStandardPrivate =
        parts[0] === 10 || // 10.0.0.0/8
        (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || // 172.16.0.0/12
        (parts[0] === 192 && parts[1] === 168); // 192.168.0.0/16

      // Check for CGNAT (Tailscale uses 100.64.0.0/10)
      const isCgnat = parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;

      if (isStandardPrivate) {
        hasStandardPrivate = true;
        addresses.push(iface.address);
      } else if (isCgnat) {
        cgnatCandidates.push(iface.address);
      }
    }
  }

  // Only allow CGNAT/Tailscale IPs if a standard private IP is also present
  // This prevents accidental exposure on shared ISP networks (CGNAT) where the user might not be behind a router.
  if (hasStandardPrivate) {
    addresses.push(...cgnatCandidates);
  } else if (cgnatCandidates.length > 0) {
    console.warn(
      "Security Warning: CGNAT/VPN IPs were detected but ignored because no standard private IP was found. If you need to use these, please add them to ALLOWED_ORIGINS in .env manually:",
      cgnatCandidates,
    );
  }

  return addresses;
};
