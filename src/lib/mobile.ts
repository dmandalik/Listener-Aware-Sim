// Desktop-only gate (§8): these are keyboard tasks. A phone/tablet without a
// real pointing device is blocked; a laptop (even a touchscreen one) is allowed.
export function isMobileDevice(): boolean {
  if (typeof navigator === "undefined" || typeof window === "undefined") return false;
  const uaMobile = /Android|iPhone|iPad|iPod|IEMobile|Opera Mini|Mobile|BlackBerry|webOS/i.test(
    navigator.userAgent || "",
  );
  const hasFinePointer = window.matchMedia?.("(any-pointer: fine)").matches ?? true;
  return uaMobile || !hasFinePointer;
}
