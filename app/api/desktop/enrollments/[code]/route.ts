import {
  getEnrollment,
  recordDeviceCapabilities,
  redeemEnrollment,
} from "@/lib/desktop-devices"

// The agent polls its own code. While the person has not approved it, this
// answers "pending" and nothing else; once approved, the device token is handed
// over exactly once, then the code is dead.
//
//   GET /api/desktop/enrollments/:code
//     202 { status: "pending" }
//     200 { status: "approved", token, deviceId }
//     410 { status: "expired" }
//     409 { status: "consumed" }
export async function GET(
  request: Request,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params
  const enrollment = await getEnrollment(code)

  if (!enrollment) {
    return Response.json({ status: "unknown" }, { status: 404 })
  }

  if (enrollment.status === "consumed") {
    return Response.json({ status: "consumed" }, { status: 409 })
  }

  if (enrollment.expiresAt.getTime() < Date.now()) {
    return Response.json({ status: "expired" }, { status: 410 })
  }

  if (enrollment.status === "pending") {
    return Response.json({ status: "pending" }, { status: 202 })
  }

  if (enrollment.status === "approved") {
    // The device carries a browser capability when it ships one
    const capabilities = (request.headers.get("x-agent-capabilities") ?? "")
      .split(",")
      .map((capability) => capability.trim())
      .filter(Boolean)

    const redeemed = await redeemEnrollment(code)
    if (!redeemed) {
      return Response.json({ status: "consumed" }, { status: 409 })
    }

    if (capabilities.length > 0) {
      await recordDeviceCapabilities(redeemed.device.id, capabilities)
    }

    return Response.json({
      status: "approved",
      token: redeemed.token,
      deviceId: redeemed.device.id,
    })
  }

  return Response.json({ status: enrollment.status }, { status: 409 })
}
