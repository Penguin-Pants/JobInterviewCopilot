/**
 * electron-vite's `?modulePath` import: the entry is bundled as a file of its
 * own, and the import is that file's absolute path at run time. Used for the
 * conversion worker (ADR-055). `vitest.config.ts` gives tests the same import.
 *
 * In a file of its own because an ambient module declaration is only picked up
 * from a declaration file that is not itself a module.
 */
declare module '*?modulePath' {
  const path: string;
  export default path;
}
