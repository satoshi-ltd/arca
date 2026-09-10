import React, { useState } from "react";
import { Platform, Text, View } from "react-native";
import {
  useDesign,
  Logo,
  Card,
  Field,
  FeatureRow,
  CodeInput,
  StepIndicator,
  Button,
  FolderRow,
  Icon,
} from "./components";
import { bytes } from "./format";
export function Onboarding({
  step,
  name,
  setName,
  address,
  setAddress,
  code,
  setCode,
  catalog,
  free,
  busy,
  start,
  pair,
  download,
  skip,
  retry,
}) {
  const { s } = useDesign();
  const device = Platform.OS === "ios" ? "iPhone" : "phone";
  const [selected, setSelected] = useState([]);
  if (step === "welcome")
    return (
      <>
        <Logo size={58} />
        <Text style={s.text}>Your personal drive, on your own machines.</Text>
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
            "Your storage, your machines. No cloud account, no telemetry.",
          ],
        ].map(([icon, title, description]) => (
          <FeatureRow key={title} icon={icon} title={title}>
            {description}
          </FeatureRow>
        ))}
        <View style={s.flex} />
        <Button
          label="Get started"
          primary
          icon="arrow-right"
          busy={busy}
          onPress={start}
        />
        <Text style={[s.caption, s.centerText]}>
          You will need a hub and a pairing code.
        </Text>
      </>
    );
  if (step === "pair")
    return (
      <>
        <Text accessibilityRole="header" style={s.title}>
          Pair with your hub
        </Text>
        <Text style={s.text}>
          Connect with a single-use code from your hub.
        </Text>
        <Field
          label={`Name this ${device}`}
          icon="phone"
          value={name}
          onChangeText={setName}
          maxLength={100}
          editable={!busy}
        />
        <Field
          label="Hub address"
          icon="server"
          value={address}
          onChangeText={setAddress}
          placeholder="https://arca.your-network"
          keyboardType="url"
          editable={!busy}
        />
        <View style={s.section}>
          <CodeInput
            label="Pairing code"
            value={code}
            onChangeText={setCode}
            editable={!busy}
          />
          <View style={s.centeredRow}>
            <Icon name="clock" size={16} />
            <Text style={s.caption}>Single use · valid ten minutes</Text>
          </View>
        </View>
        <View style={s.flex} />
        <Button
          label={`Pair this ${device}`}
          primary
          icon="key"
          busy={busy}
          disabled={!name.trim() || !address.trim() || code.length !== 6}
          onPress={pair}
        />
        <StepIndicator step={1} />
      </>
    );
  const folders = catalog?.volumes || [];
  const chosen = folders.filter((folder) => selected.includes(folder.id));
  const size = chosen.reduce((total, folder) => total + (folder.bytes || 0), 0);
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
          Whole folders, kept on this {device}. Add more any time.
        </Text>
      </View>
      {!catalog ? (
        <Button label="Load folders" onPress={retry} busy={busy} />
      ) : !folders.length ? (
        <Card>
          <Text style={s.text}>
            Your hub has no shared folders yet. Add one on the hub, then choose
            it here.
          </Text>
        </Card>
      ) : null}
      <View style={s.folderList}>
        {folders.map((folder) => (
          <FolderRow
            key={folder.id}
            name={folder.name}
            description={
              folder.policyError ||
              `${folder.files ?? "—"} files · ${Number.isFinite(folder.bytes) ? bytes(folder.bytes) : "Size unavailable"}`
            }
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
        ))}
      </View>
      <Text style={[s.caption, s.centerText]}>
        {chosen.length === 1 ? chosen[0].name : `${chosen.length} folders`} ·{" "}
        {bytes(size)} ·{" "}
        {Number.isFinite(free)
          ? `${bytes(free)} free on this ${device}`
          : "Checking available space"}
      </Text>
      <View style={s.flex} />
      <Button
        label={`Download ${chosen.length} ${chosen.length === 1 ? "folder" : "folders"}`}
        icon="download"
        primary
        disabled={!chosen.length}
        busy={busy}
        onPress={() => download(chosen.map((folder) => folder.id))}
      />
      <Button label="Skip for now" quiet busy={busy} onPress={skip} />
      <StepIndicator step={2} />
    </>
  );
}
