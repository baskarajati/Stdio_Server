import { getCurrentWindow } from '@tauri-apps/api/window';

/**
 * The desktop entry point.
 *
 * The window loads the Stdio web app. SOL-5 decides how the bundle ships the web
 * assets. Read `docs/adr/0001-stack.md`, the section 'Open question: the Mac shell'.
 */
export async function showMainWindow(): Promise<void> {
  await getCurrentWindow().show();
}
