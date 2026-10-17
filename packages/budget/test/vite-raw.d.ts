// Ambient declaration for vite `?raw` text imports (migration SQL).
declare module '*?raw' {
  const content: string;
  export default content;
}
