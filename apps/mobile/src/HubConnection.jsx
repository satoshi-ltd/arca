import React from "react";
import { Button, MachineRow, useDesign } from "./components";
import { deviceSegments } from "./device-line.js";
export function HubConnection({
  connection,
  name,
  machine,
  busy,
  disconnect,
  retry,
  grouped = false,
}) {
  const { wide } = useDesign();
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
      address={[address.host, connection.leaving ? "Disconnection pending" : ""]
        .filter(Boolean)
        .join(" · ")}
      actions={
        <Button
          danger
          iconOnly={!wide}
          icon="unplug"
          label={connection.leaving ? "Retry disconnect" : "Disconnect…"}
          disabled={busy}
          onPress={connection.leaving ? retry : disconnect}
        />
      }
    />
  );
}
