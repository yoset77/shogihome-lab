import { describe, it, expect } from "vitest";
import { getLocalIpAddresses } from "@/server/helpers/ip";
import os from "os";

// Helper to create mock NetworkInterfaces
const createMockInterfaces = (ips: string[]): NodeJS.Dict<os.NetworkInterfaceInfo[]> => {
  return {
    eth0: ips.map((ip) => ({
      address: ip,
      netmask: "255.255.255.0",
      family: "IPv4",
      mac: "00:00:00:00:00:00",
      internal: false,
      cidr: `${ip}/24`,
    })),
  } as unknown as NodeJS.Dict<os.NetworkInterfaceInfo[]>;
};

describe("getLocalIpAddresses", () => {
  it("should return standard private IPs", () => {
    const mockInterfaces = createMockInterfaces(["192.168.1.10", "10.0.0.5"]);
    const result = getLocalIpAddresses(mockInterfaces);
    expect(result).toContain("192.168.1.10");
    expect(result).toContain("10.0.0.5");
    expect(result).toHaveLength(2);
  });

  it("should return CGNAT IPs if a standard private IP is present (e.g. Tailscale + WiFi)", () => {
    const mockInterfaces = createMockInterfaces(["192.168.1.10", "100.65.0.1"]);
    const result = getLocalIpAddresses(mockInterfaces);
    expect(result).toContain("192.168.1.10");
    expect(result).toContain("100.65.0.1");
    expect(result).toHaveLength(2);
  });

  it("should NOT return CGNAT IPs if NO standard private IP is present (e.g. direct ISP connection)", () => {
    const mockInterfaces = createMockInterfaces(["100.65.0.1", "203.0.113.1"]); // CGNAT + Public IP
    const result = getLocalIpAddresses(mockInterfaces);
    expect(result).not.toContain("100.65.0.1");
    expect(result).not.toContain("203.0.113.1"); // Public IP should be ignored too
    expect(result).toHaveLength(0);
  });

  it("should ignore loopback and non-IPv4 addresses", () => {
    const mockInterfaces = {
      lo: [
        {
          address: "127.0.0.1",
          netmask: "255.0.0.0",
          family: "IPv4",
          mac: "00:00:00:00:00:00",
          internal: true,
          cidr: "127.0.0.1/8",
        },
      ],
      eth0: [
        {
          address: "fe80::1",
          netmask: "ffff:ffff:ffff:ffff::",
          family: "IPv6",
          mac: "00:00:00:00:00:00",
          internal: false,
          cidr: "fe80::1/64",
          scopeid: 0,
        },
      ],
    } as unknown as NodeJS.Dict<os.NetworkInterfaceInfo[]>;

    const result = getLocalIpAddresses(mockInterfaces);
    expect(result).toHaveLength(0);
  });

  it("should ignore public IPs", () => {
    const mockInterfaces = createMockInterfaces(["8.8.8.8", "1.1.1.1"]);
    const result = getLocalIpAddresses(mockInterfaces);
    expect(result).toHaveLength(0);
  });
});
