import React, { useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { useDesign, Field, CodeInput, Button, Icon } from "./components";

export function PairingForm({
  name,
  setName,
  address,
  setAddress,
  code,
  setCode,
  codeError = "",
  busy,
  blocked = false,
  back,
  pair,
}) {
  const { s } = useDesign();
  const [details, setDetails] = useState(false);
  const device = Platform.OS === "ios" ? "iPhone" : "phone";
  return (
    <>
      {!!back && (
        <Button label="Back" icon="back" quiet disabled={busy} onPress={back} />
      )}
      <Text accessibilityRole="header" style={s.title}>
        Pair with your hub
      </Text>
      <Text style={s.text}>
        On the hub, open Devices → Pair a device. It shows the address and a
        single-use code.
      </Text>
      <Field
        label="Hub address"
        icon="server"
        value={address}
        onChangeText={setAddress}
        placeholder="https://arca.your-network"
        keyboardType="url"
        editable={!busy}
      />
      <Text style={s.caption}>Use HTTPS or Tailscale.</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Using local Wi-Fi?"
        accessibilityState={{ expanded: details }}
        onPress={() => setDetails((value) => !value)}
      >
        <Text style={[s.caption, s.active]}>Using local Wi-Fi?</Text>
      </Pressable>
      {details && (
        <Text style={s.caption}>
          For local Wi-Fi, enable HTTP in the hub’s Settings and enter its
          private IPv4 address. Local HTTP traffic is not encrypted.
        </Text>
      )}
      <View style={s.section}>
        <CodeInput
          label="Pairing code"
          value={code}
          onChangeText={setCode}
          editable={!busy}
        />
        {codeError ? (
          <Text
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
            style={[s.caption, s.errorText]}
          >
            {codeError}
          </Text>
        ) : (
          <View style={s.centeredRow}>
            <Icon name="clock" size={16} />
            <Text style={s.caption}>Single use · valid ten minutes</Text>
          </View>
        )}
      </View>
      <Field
        label={`Name this ${device}`}
        icon="phone"
        value={name}
        onChangeText={setName}
        maxLength={100}
        editable={!busy}
      />
      <View style={s.flex} />
      <Button
        label={`Pair this ${device}`}
        primary
        icon="key"
        busy={busy}
        disabled={
          blocked || !name.trim() || !address.trim() || code.length !== 6
        }
        onPress={pair}
      />
    </>
  );
}
