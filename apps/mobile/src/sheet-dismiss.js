export const DRAG_DISMISS = 60;
export const draggedDown = ({ dy, vy }) => dy > DRAG_DISMISS || (dy > 24 && vy > 0.8);
