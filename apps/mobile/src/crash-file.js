import { File, Paths } from "expo-file-system";

const store = () => new File(Paths.document, "arca-crash.json");

export const crashFile = {
  read: () => {
    const file = store();
    return file.exists ? file.textSync() : null;
  },
  write: (text) => store().write(text),
  remove: () => store().delete(),
};
