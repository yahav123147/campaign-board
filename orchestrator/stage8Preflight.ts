/**
 * Stage 8 used to skip itself after seeing only a recently-fired pixel and a
 * successful generic stats response. Neither proves that a Purchase occurred,
 * that it carried matching data, or that CAPI sent it. Keep this hook fail
 * closed for saved registries that still reference the old conditional.
 */
export async function checkPixelHealthSkip(): Promise<{ skip: false; reason: string }> {
  return {
    skip: false,
    reason:
      "Stage 8 cannot be skipped from generic pixel statistics. Typed Purchase, had_pii, and server-event evidence is required.",
  };
}
