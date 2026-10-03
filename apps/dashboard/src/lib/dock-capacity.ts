/** Reserve fixed controls and space for magnification at the viewport edges. */
export function dockAppCapacity(viewportWidth: number, trayWidth: number, appCount: number, hasSettings: boolean): number {
  const fixedWidth = 32 + 18 + 52 + 16 + 80 + (hasSettings ? 64 : 0);
  const slots = Math.max(0, Math.floor((viewportWidth - trayWidth - fixedWidth) / 52));
  // More apps takes one slot only when needed. Keep the user's order stable.
  return appCount <= slots ? appCount : Math.max(0, slots - 1);
}
