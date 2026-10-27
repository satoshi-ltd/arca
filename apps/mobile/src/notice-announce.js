export const noticeAnnouncement = (item) => [item.title, item.body].filter(Boolean).join(". ");
