import { resend } from "@/lib/resend"

export async function sendEmail({
  to,
  subject,
  body,
}: {
  to: string
  subject: string
  body: string
}) {
  const { data, error } = await resend().emails.send({
    // Resend's test domain by default; an operator sets RESEND_FROM to the
    // domain they verified. Same sender for the automation node and Godfather.
    from: process.env.RESEND_FROM || "onboarding@resend.dev",
    to,
    subject,
    html: body,
  })

  // The Resend SDK returns { data, error } and does not throw on API errors.
  // Throw so the run marks this step failed instead of looking successful.
  if (error || !data) {
    throw new Error(error?.message ?? "Resend returned no email id")
  }

  return { id: data.id }
}
