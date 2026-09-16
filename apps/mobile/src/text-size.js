export const textSizes = [
  { value: 0.9, label: "Small" },
  { value: 1, label: "Default" },
  { value: 1.15, label: "Large" },
  { value: 1.3, label: "Largest" },
];
export function textScale(value) {
  const scale = Number(value);
  return textSizes.some((option) => option.value === scale) ? scale : 1;
}
