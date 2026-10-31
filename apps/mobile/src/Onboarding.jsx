import React, { useState } from "react";
import { Platform, View } from "react-native";
import { Text } from "./Text";
import {
  useDesign,
  Logo,
  Card,
  FeatureRow,
  StepIndicator,
  Button,
  FolderRow,
  Icon,
  SegmentedControl,
} from "./components";
import { PairingForm } from "./PairingForm";
import { bytes, count, folderSize } from "./format";
import { defaultMode, downloadBytes, mediaKind, startLabel } from "./onboarding";
export function Onboarding({
  step,
  name,
  setName,
  address,
  setAddress,
  code,
  setCode,
  codeError,
  back,
  catalog,
  free,
  busy,
  start,
  pair,
  download,
  skip,
  retry,
  audioStreams,
  sizes,
}) {
  const { s } = useDesign();
  const device = Platform.OS === "ios" ? "iPhone" : "phone";
  const [selected, setSelected] = useState([]);
  const [chosenModes, setChosenModes] = useState({});
  if (step === "welcome")
    return (
      <>
        <Logo size={58} />
        <Text style={s.text}>Your personal drive, on your own devices.</Text>
        <Text accessibilityRole="header" style={s.displayTitle}>
          Many devices.{"\n"}
          <Text style={s.emphasis}>One space.</Text>
        </Text>
        {[
          [
            "folder-check",
            "Complete local copies",
            `The folders you choose, whole, on this ${device}. Offline is a normal day.`,
          ],
          [
            "history",
            "A way back",
            "Restore earlier versions. Conflicts keep both files.",
          ],
          [
            "server",
            "A hub you control",
            "Your storage, your devices. No cloud account, no telemetry.",
          ],
        ].map(([icon, title, description]) => (
          <FeatureRow key={title} icon={icon} title={title}>
            {description}
          </FeatureRow>
        ))}
        <Card title="You need a hub first">
          <Text style={s.text}>
            Install Arca on a computer or a server and make it the hub. Then
            open Devices → Pair a device there to get a code.
          </Text>
        </Card>
        <View style={s.flex} />
        <Button
          label="Get started"
          primary
          icon="arrow-right"
          busy={busy}
          onPress={start}
        />
      </>
    );
  if (step === "pair")
    return (
      <>
        <PairingForm
          name={name}
          setName={setName}
          address={address}
          setAddress={setAddress}
          code={code}
          setCode={setCode}
          codeError={codeError}
          busy={busy}
          back={back}
          pair={pair}
        />
        <StepIndicator step={1} />
      </>
    );
  const folders = catalog?.volumes || [];
  const kinds = Object.fromEntries(folders.map((folder) => [folder.id, mediaKind(catalog, folder, audioStreams)]));
  const modes = Object.fromEntries(folders.map((folder) => [folder.id, kinds[folder.id] ? chosenModes[folder.id] || defaultMode(kinds[folder.id]) : "keep"]));
  const chosen = folders.filter((folder) => selected.includes(folder.id));
  const action = startLabel(chosen, modes);
  return (
    <>
      <View style={s.section}>
        <View style={s.row}>
          <Icon name="check-circle" size={16} />
          <Text style={[s.heading, s.active]}>
            Paired with {catalog?.name || "your hub"}
          </Text>
        </View>
        <Text accessibilityRole="header" style={s.title}>
          Make room for what matters
        </Text>
        <Text style={s.text}>
          Folders are kept on this {device}; music and movies can stream instead. Add more any time.
        </Text>
      </View>
      {!catalog ? (
        <Button label="Load folders" onPress={retry} busy={busy} />
      ) : !folders.length ? (
        <Card>
          <Text style={s.text}>
            Your hub has no shared folders yet. Add one on the hub, then choose it here.
          </Text>
        </Card>
      ) : null}
      <View style={s.folderList}>
        {folders.map((folder) => (
          <React.Fragment key={folder.id}>
            <FolderRow
              name={folder.name}
              description={folder.policyError || (modes[folder.id] === "stream" ? "Streams from hub" : folderSize(folder))}
              selectable
              selected={selected.includes(folder.id)}
              disabled={
                busy || !!folder.policyError || !Number.isFinite(folder.bytes)
              }
              onPress={() =>
                setSelected((previous) =>
                  previous.includes(folder.id)
                    ? previous.filter((id) => id !== folder.id)
                    : [...previous, folder.id],
                )
              }
            />
            {!!kinds[folder.id] && selected.includes(folder.id) && (
              <SegmentedControl
                fit
                options={[
                  { value: "stream", label: "Stream" },
                  { value: "keep", label: "Keep" },
                ]}
                value={modes[folder.id]}
                onChange={(value) => setChosenModes((previous) => ({ ...previous, [folder.id]: value }))}
              />
            )}
          </React.Fragment>
        ))}
      </View>
      <Text style={[s.caption, s.centerText]}>
        {chosen.length === 1 ? chosen[0].name : count(chosen.length, "folder", "folders")} ·{" "}
        {bytes(downloadBytes(chosen, modes, sizes))} to download ·{" "}
        {Number.isFinite(free)
          ? `${bytes(free)} free`
          : "Checking available space"}
      </Text>
      <View style={s.flex} />
      <Button
        label={action.label}
        icon={action.icon}
        primary
        disabled={!chosen.length}
        busy={busy}
        onPress={() => download(chosen.map((folder) => folder.id), modes)}
      />
      <Button
        label="Skip for now"
        quiet
        busy={busy}
        onPress={skip}
      />
      <StepIndicator step={2} />
    </>
  );
}
