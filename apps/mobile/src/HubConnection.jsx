import React from "react";
import { Button, MachineRow, useDesign } from "./components";
import { deviceCells, deviceSegments, foldRowFits } from "./device-line.js";
export function HubConnection({
  connection,
  name,
  machine,
  presence,
  busy,
  disconnect,
  retry,
  grouped = false,
}) {
  const { wide: wideLayout, fontScale = 1 } = useDesign();
  const wide = wideLayout && foldRowFits(fontScale);
  const address = new URL(connection.url);
  return (
    <MachineRow
      grouped={grouped}
      hub
      role="Hub"
      name={name || "Hub"}
      platform={machine?.platform}
      segments={deviceSegments({
        platform: machine?.platform,
        folders: machine?.selectedFolders,
        size: machine?.indexedBytes,
      })}
      cells={deviceCells({
        version: machine?.version,
        folders: machine?.selectedFolders,
        size: machine?.indexedBytes,
      })}
      presence={presence}
      address={[address.host, connection.leaving ? "Disconnection pending" : ""]
        .filter(Boolean)
        .join(" · ")}
      actions={
        <Button
          danger
          iconOnly={!wide}
          size={wide ? "compact" : "small"}
          icon="unplug"
          label={connection.leaving ? "Retry disconnect" : "Disconnect…"}
          disabled={busy}
          onPress={connection.leaving ? retry : disconnect}
        />
      }
    />
  );
}
