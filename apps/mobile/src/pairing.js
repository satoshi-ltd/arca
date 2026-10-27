const MESSAGES = {
  401: "That code is not valid or has expired. Check the hub for a new one.",
};

export const rejectedCode = (error) =>
  error?.status === 429
    ? error.message
    : error?.status === 401 && !error.code
      ? MESSAGES[401]
      : null;
