/** "1 image", "3 images": the count the server's terminal lines use. */
export const images = (n: number): string => `${n} ${n === 1 ? "image" : "images"}`;
