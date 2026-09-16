/**
 * Stylesheets are side-effect imports the bundler turns into a `<link>` tag.
 * They have no runtime shape, so they are declared rather than typed.
 *
 * In a file of its own because an ambient module declaration is only picked up
 * from a declaration file that is not itself a module, and `global.d.ts` is one.
 */
declare module '*.css';
