// Vite's ?raw imports (used to read .dev.vars.example in tests).
declare module '*?raw' {
  const content: string;
  export default content;
}
