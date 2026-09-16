import { brandMark } from "./palette.js";
import { KeyboardPane, KeyboardScrollView, FieldFocus } from "./KeyboardPane";
import { geometry as g } from "./design-tokens.js";
import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Animated,
  AccessibilityInfo,
  StyleSheet,
  View,
  Text,
  Pressable,
  TextInput,
  Modal,
  ScrollView,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Svg, {
  Path,
  Rect,
  Circle,
  Line,
  Polyline,
  Polygon,
  Ellipse,
} from "react-native-svg";
import { icons } from "./icons";
export const Design = createContext(null);
export const useDesign = () => useContext(Design);
// One representative row for pending lists, matching desktop scaffold geometry.
export function Scaffold({
  kind = "card",
  dashed = false,
  label = "Loading content",
}) {
  const { s } = useDesign();
  return (
    <View
      accessible
      accessibilityLabel={label}
      accessibilityRole="progressbar"
      style={[s.scaffoldRow, dashed && s.scaffoldDashed]}
    >
      <View style={[s.scaffoldMark, kind === "history" && s.scaffoldDot]} />
      <View style={s.scaffoldCopy}>
        <View style={[s.scaffoldLine, s.scaffoldTitle]} />
        <View style={[s.scaffoldLine, s.scaffoldLong]} />
      </View>
      <View style={[s.scaffoldLine, s.scaffoldShort]} />
    </View>
  );
}
const busyStyles = StyleSheet.create({
  brandSlot: {
    width: g.screenTitleLogo,
    height: g.screenTitleLogo,
    alignItems: "center",
    justifyContent: "center",
  },
  brandBusy: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  grid: { width: 16, height: 16, gap: 2 },
  small: { transform: [{ scale: 0.875 }], width: 16, height: 16 },
  row: { flexDirection: "row", gap: 2 },
  dot: { width: 4, height: 4, borderRadius: 3 },
});
export function Busy({ color, style, size, accessibilityLabel = "Loading" }) {
  const { c } = useDesign();
  const dots = useRef(
    Array.from(
      { length: 9 },
      (_, i) => new Animated.Value(i % 3 === 0 ? 1 : 0.4),
    ),
  ).current;
  useEffect(() => {
    let active = true;
    let loops = [];
    const update = (reduce) => {
      loops.forEach((loop) => loop.stop());
      dots.forEach((dot, i) => dot.setValue(i % 3 === 0 ? 1 : 0.4));
      if (reduce || !active) return;
      loops = dots.map((dot, i) =>
        Animated.loop(
          Animated.sequence([
            Animated.delay((i * 170) % 650),
            Animated.timing(dot, {
              toValue: 1,
              duration: 450,
              useNativeDriver: true,
            }),
            Animated.timing(dot, {
              toValue: 0.35,
              duration: 650,
              useNativeDriver: true,
            }),
          ]),
        ),
      );
      loops.forEach((loop) => loop.start());
    };
    AccessibilityInfo.isReduceMotionEnabled().then(update);
    const subscription = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      update,
    );
    return () => {
      active = false;
      loops.forEach((loop) => loop.stop());
      subscription.remove();
    };
  }, [dots]);
  return (
    <View
      style={[busyStyles.grid, size === "small" && busyStyles.small, style]}
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
    >
      {[0, 1, 2].map((row) => (
        <View key={row} style={busyStyles.row}>
          {[0, 1, 2].map((column) => (
            <Animated.View
              key={column}
              style={[
                busyStyles.dot,
                {
                  backgroundColor: color || c.ink,
                  opacity: dots[row * 3 + column],
                },
              ]}
            />
          ))}
        </View>
      ))}
    </View>
  );
}
const shapes = {
  path: Path,
  rect: Rect,
  circle: Circle,
  line: Line,
  polyline: Polyline,
  polygon: Polygon,
  ellipse: Ellipse,
};
export function Icon({ name, color, size = 20 }) {
  const { c } = useDesign();
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color || c.ink}
      strokeWidth={g.iconStroke}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {(icons[name] || icons.folders).map(([kind, props], index) => {
        const Shape = shapes[kind];
        return <Shape key={index} {...props} />;
      })}
    </Svg>
  );
}
export function Logo({ size = 76, glyph = true }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 512 512">
      <Rect
        x="8"
        y="8"
        width="496"
        height="496"
        rx="116"
        fill={brandMark.tile}
      />
      {glyph && (
        <>
          <Path
            d="M136 370V232a120 120 0 0 1 240 0v138h-58V232a62 62 0 0 0-124 0v138z"
            fill={brandMark.arch}
          />
          <Rect
            x="224"
            y="276"
            width="64"
            height="94"
            rx="8"
            fill={brandMark.door}
          />
        </>
      )}
    </Svg>
  );
}
export function BrandActivity() {
  const { active } = useDesign();
  return (
    <View style={busyStyles.brandSlot}>
      <Logo size={g.screenTitleLogo} glyph={!active} />
      {active && (
        <View style={busyStyles.brandBusy}>
          <Busy color={brandMark.arch} accessibilityLabel="Arca: updating" />
        </View>
      )}
    </View>
  );
}
export function Section({ children }) {
  const { s } = useDesign();
  return <View style={s.section}>{children}</View>;
}
export function ScreenTitle({
  children,
  detail = false,
  subtitle,
  contentIcon,
}) {
  const { s, wide } = useDesign();
  return (
    <View style={s.screenTitle}>
      {!wide && <BrandActivity />}
      {wide && contentIcon && (
        <View style={[s.tile, s.detailTile]}>
          <Icon name={contentIcon} />
        </View>
      )}
      {detail || subtitle != null ? (
        <View style={[s.flex, s.stack]}>
          <Text
            accessibilityRole="header"
            style={detail ? s.detailTitle : s.title}
          >
            {children}
          </Text>
          {subtitle != null && <Text style={s.caption}>{subtitle}</Text>}
        </View>
      ) : (
        <Text accessibilityRole="header" style={[s.title, s.flex]}>
          {children}
        </Text>
      )}
    </View>
  );
}
export function Button({
  label,
  onPress,
  primary = false,
  iconOnly = false,
  disabled = false,
  busy = false,
  icon,
  quiet = false,
  size = "normal",
  danger = false,
}) {
  const { s, c } = useDesign();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled || busy, busy }}
      disabled={disabled || busy}
      onPress={onPress}
      hitSlop={size === "small" ? 6 : undefined}
      style={[
        s.button,
        iconOnly && s.iconButton,
        size === "small" && s.smallButton,
        size === "small" && iconOnly && s.smallIconButton,
        primary && s.primary,
        quiet && s.quietButton,
        danger && s.dangerButton,
        danger && primary && s.destructivePrimary,
        (disabled || busy) && s.disabled,
      ]}
    >
      {busy ? (
        <Busy color={primary ? c.onAccent : danger ? c.danger : c.ink} />
      ) : icon ? (
        <Icon
          name={icon}
          size={size === "small" ? g.buttonSmallIcon : g.buttonIcon}
          color={primary ? c.onAccent : danger ? c.danger : c.ink}
        />
      ) : null}
      {!iconOnly && (
        <Text
          style={[
            s.buttonLabel,
            primary && s.primaryLabel,
            quiet && s.active,
            danger && !primary && s.errorText,
          ]}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}
export function Field({ label, icon, onFocus, onBlur, ...props }) {
  const input = useRef(null);
  const focus = useContext(FieldFocus);
  const { s, c } = useDesign();
  return (
    <View style={s.section}>
      <Text style={s.heading}>{label}</Text>
      <View style={icon && s.inputShell}>
        {icon && <Icon name={icon} color={c.mute} />}
        <TextInput
          ref={input}
          onFocus={(event) => {
            focus?.focus(input.current);
            onFocus?.(event);
          }}
          onBlur={(event) => {
            focus?.blur(input.current);
            onBlur?.(event);
          }}
          accessibilityLabel={label}
          placeholderTextColor={c.mute}
          style={icon ? [s.input, s.inputEmbedded] : s.input}
          autoCapitalize="none"
          autoCorrect={false}
          {...props}
        />
      </View>
    </View>
  );
}
export function FeatureRow({ icon, title, children }) {
  const { s } = useDesign();
  return (
    <View style={s.featureRow}>
      <View style={[s.tile, s.tileLarge]}>
        <Icon name={icon} />
      </View>
      <View style={[s.flex, s.stack]}>
        <Text style={s.heading}>{title}</Text>
        <Text style={s.text}>{children}</Text>
      </View>
    </View>
  );
}
export function StepIndicator({ step, count = 3 }) {
  const { s } = useDesign();
  return (
    <View
      accessibilityLabel={`Step ${step + 1} of ${count}`}
      style={s.stepIndicator}
    >
      {Array.from({ length: count }, (_, index) => (
        <View
          key={index}
          style={[s.stepDot, index === step && s.stepDotActive]}
        />
      ))}
    </View>
  );
}
export function CodeInput({ label, value, onChangeText, editable = true }) {
  const { s, c } = useDesign();
  const [focused, setFocused] = useState(false);
  const input = useRef(null);
  const focus = useContext(FieldFocus);
  return (
    <View style={s.section}>
      <Text style={s.heading}>{label}</Text>
      <Pressable
        onPress={() => input.current?.focus()}
        accessible={false}
        style={s.codeControl}
      >
        <View
          pointerEvents="none"
          accessible={false}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={s.codeCells}
        >
          {Array.from({ length: 6 }, (_, index) => (
            <React.Fragment key={index}>
              {index === 3 && <Text style={s.codeSeparator}>–</Text>}
              <View
                style={[
                  s.codeCell,
                  focused &&
                    Math.min(value.length, 5) === index &&
                    s.controlFocused,
                ]}
              >
                <Text style={s.codeDigit}>
                  {value[index] ||
                    (focused && value.length === index ? "│" : "")}
                </Text>
              </View>
            </React.Fragment>
          ))}
        </View>
        <TextInput
          ref={input}
          value={value}
          editable={editable}
          accessibilityLabel={label}
          onChangeText={(next) =>
            onChangeText(next.replace(/[^0-9]/g, "").slice(0, 6))
          }
          keyboardType="number-pad"
          textContentType="oneTimeCode"
          autoComplete="one-time-code"
          autoCorrect={false}
          caretHidden
          selectionColor={c.accent}
          style={s.codeCapture}
          onFocus={() => {
            setFocused(true);
            focus?.focus(input.current);
          }}
          onBlur={() => {
            setFocused(false);
            focus?.blur(input.current);
          }}
        />
      </Pressable>
    </View>
  );
}
export function Card({
  title,
  children,
  actions,
  available = false,
  danger = false,
  grouped = false,
  divider = false,
}) {
  const { s } = useDesign();
  return (
    <View
      style={[
        grouped ? s.settingRow : s.card,
        available && s.available,
        danger && s.dangerCard,
        divider && s.separator,
        actions && s.settingWithActions,
      ]}
    >
      {actions ? (
        <>
          <View style={s.settingDescription}>
            {title ? <Text style={s.heading}>{title}</Text> : null}
            {children}
          </View>
          <View style={s.settingActions}>{actions}</View>
        </>
      ) : (
        <>
          {title ? <Text style={s.heading}>{title}</Text> : null}
          {children}
        </>
      )}
    </View>
  );
}
export function Tag({ children, variant }) {
  const { s } = useDesign();
  return (
    <View
      style={[
        s.machineTag,
        variant === "hub" && s.hubTag,
        variant === "self" && s.selfTag,
      ]}
    >
      <Text
        style={[
          s.machineTagText,
          variant === "hub" && s.hubTagText,
          variant === "self" && s.selfTagText,
        ]}
      >
        {children}
      </Text>
    </View>
  );
}

export function Badge({ children, iconOnly = false }) {
  const { s, c } = useDesign();
  const error = ["Needs attention", "Revoked"].includes(children);
  const warning = ["Incomplete", "Paused", "Not yet synced"].includes(children);
  const success = children === "Up to date";
  return (
    <View
      style={[
        s.badge,
        iconOnly && s.badgeIcon,
        !success && s.badgeNeutral,
        children === "Syncing" && s.badgeBusy,
        warning && s.badgeWarning,
        error && s.badgeError,
      ]}
      accessible={iconOnly || undefined}
      accessibilityLabel={iconOnly ? children : undefined}
    >
      {success && <Icon name="check-circle" size={g.pillIcon} color={c.okFg} />}
      {children === "Current" && (
        <Icon name="check" size={g.pillIcon} color={c.soft} />
      )}
      {children === "Linked" && (
        <Icon name="link" size={g.pillIcon} color={c.soft} />
      )}
      {children === "Syncing" && <Busy size="small" color={c.accent} />}
      {iconOnly &&
        !success &&
        !["Syncing", "Current", "Linked"].includes(children) && (
          <Icon
            name={
              error
                ? "alert"
                : ["Paused", "Disabled"].includes(children)
                  ? "pause"
                  : "clock"
            }
            size={g.pillIcon}
            color={error ? c.danger : warning ? c.warning : c.soft}
          />
        )}
      {!iconOnly && (
        <Text
          style={[
            s.badgeText,
            !success && s.badgeNeutralText,
            warning && s.badgeWarningText,
            error && s.errorText,
          ]}
        >
          {children}
        </Text>
      )}
    </View>
  );
}

export function Toggle({
  label,
  description,
  value,
  onChange,
  disabled = false,
}) {
  const { s, c } = useDesign();
  return (
    <View style={s.row}>
      <View style={s.flex}>
        <Text style={s.heading}>{label}</Text>
        {description && <Text style={s.text}>{description}</Text>}
      </View>
      <Pressable
        accessibilityRole="switch"
        accessibilityLabel={label}
        accessibilityState={{ checked: value, disabled }}
        disabled={disabled}
        onPress={() => onChange(!value)}
        style={[s.switchTarget, disabled && s.disabled]}
      >
        <View style={[s.switchTrack, value && s.switchOn]}>
          <View style={[s.switchThumb, value && s.switchThumbOn]} />
        </View>
      </Pressable>
    </View>
  );
}
export function Breadcrumbs({ name, directory, onChange }) {
  const { s, c } = useDesign();
  const parts = directory.split("/").filter(Boolean);
  const crumbs = [
    { label: name, path: "" },
    ...parts.map((label, i) => ({
      label,
      path: parts.slice(0, i + 1).join("/") + "/",
    })),
  ];
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={s.breadcrumb}
    >
      <Icon name="folders" size={12} color={c.mute} />
      {crumbs.map((crumb, i) => (
        <React.Fragment key={crumb.path}>
          {i > 0 && <Icon name="chevron" size={12} color={c.mute} />}
          {i === crumbs.length - 1 ? (
            <Text accessibilityRole="text" style={s.caption}>
              {crumb.label}
            </Text>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Open ${crumb.label}`}
              style={s.breadcrumbButton}
              onPress={() => onChange(crumb.path)}
            >
              <Text style={[s.caption, s.active]}>{crumb.label}</Text>
            </Pressable>
          )}
        </React.Fragment>
      ))}
    </ScrollView>
  );
}

export function Sheet({
  overlay,
  title,
  onClose,
  children,
  busy = false,
  busyLabel = "",
}) {
  const { s, wide } = useDesign();
  return (
    <Modal
      visible
      animationType={wide ? "fade" : "slide"}
      supportedOrientations={["portrait", "landscape-left", "landscape-right"]}
      transparent
      presentationStyle="overFullScreen"
      onRequestClose={busy ? () => {} : onClose}
    >
      <KeyboardPane style={s.modalOverlay}>
        <SafeAreaView style={s.modalPanel}>
          {!title && <View style={s.sheetHandle} />}
          {!!title && (
            <View style={s.sheetHeader}>
              <Text accessibilityRole="header" style={[s.heading, s.flex]}>
                {title}
              </Text>
              <Button
                label="Close"
                quiet
                icon="close"
                iconOnly
                disabled={busy}
                onPress={onClose}
              />
            </View>
          )}
          <KeyboardScrollView
            style={s.sheetScroll}
            contentContainerStyle={s.content}
            keyboardShouldPersistTaps="handled"
          >
            {busy && !!busyLabel && (
              <View style={s.row} accessibilityLiveRegion="polite">
                <Busy />
                <Text style={s.text}>{busyLabel}</Text>
              </View>
            )}
            {children}
          </KeyboardScrollView>
        </SafeAreaView>
        {overlay}
      </KeyboardPane>
    </Modal>
  );
}

export function ActionRow({ label, icon, onPress, disabled, danger, divider }) {
  const { s, c } = useDesign();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[s.actionRow, divider && s.separator, disabled && s.disabled]}
    >
      <Icon name={icon} size={20} color={danger ? c.danger : c.soft} />
      <Text style={[s.buttonLabel, s.flex, danger && s.errorText]}>
        {label}
      </Text>
    </Pressable>
  );
}

export function FolderRow({
  selectable = false,
  selected = false,
  grouped = false,
  divider = false,
  icon = "folders",
  name,
  description,
  status,
  available,
  onPress,
  disabled,
}) {
  const { s, c, wide } = useDesign();
  const contents = (
    <>
      <View
        style={[s.tile, available && s.tileAvailable]}
        accessibilityLabel={status === "Syncing" ? "Syncing" : undefined}
      >
        {status === "Syncing" ? (
          <Busy color={c.accent} />
        ) : (
          <Icon name={icon} size={16} color={available ? c.mute : c.accent} />
        )}
      </View>
      <View style={[s.flex, s.stack]}>
        <Text style={s.rowTitle}>{name}</Text>
        {!!description && <Text style={s.caption}>{description}</Text>}
      </View>
      {selectable ? (
        selected ? (
          <View style={s.selectionCheck}>
            <Icon name="check" size={16} color={c.onAccent} />
          </View>
        ) : (
          <Icon name="circle" color={c.line} size={24} />
        )
      ) : available ? (
        <Button
          label="Select"
          icon="download"
          disabled={disabled}
          onPress={onPress}
        />
      ) : (
        <View style={s.rowAction}>
          {status && !["Syncing", "Up to date"].includes(status) && (
            <Badge iconOnly={!wide}>{status}</Badge>
          )}
          <Icon name="chevron" color={c.mute} />
        </View>
      )}
    </>
  );
  return available ? (
    <View style={[s.card, s.available, s.folderRow]}>{contents}</View>
  ) : (
    <Pressable
      accessibilityRole={selectable ? "checkbox" : "button"}
      accessibilityLabel={`${selectable ? "Select" : "Open"} ${name}${status ? `, ${status}` : ""}`}
      accessibilityState={{
        disabled: !!disabled,
        ...(selectable ? { checked: selected } : {}),
      }}
      disabled={disabled}
      onPress={onPress}
      style={[
        !grouped && s.card,
        s.folderRow,
        grouped && s.groupedFolderRow,
        selectable && selected && s.selectedCard,
        divider && s.separator,
      ]}
    >
      {contents}
    </Pressable>
  );
}
export function Navigation({ wide, compact, view, onSelect, name, hub }) {
  const { s, c } = useDesign();
  const Container = wide ? SafeAreaView : View;
  return (
    <Container
      edges={["top", "bottom", "left"]}
      style={wide ? s.navigation : s.tabs}
    >
      {wide && (
        <>
          <View style={[s.brand, compact && s.compactBrand]}>
            <BrandActivity />
            {!compact && <Text style={s.heading}>arca</Text>}
          </View>
          {!compact && (
            <View style={s.identity}>
              <Icon name="phone" size={16} />
              <Text numberOfLines={1} style={[s.flex, s.caption]}>
                {name}
              </Text>
              <Text style={s.caption}>Replica</Text>
            </View>
          )}
        </>
      )}
      {["Folders", "Machines", "History", "Settings"].map((tab) => (
        <Pressable
          key={tab}
          accessibilityRole="tab"
          accessibilityLabel={tab}
          accessibilityState={{ selected: view === tab }}
          onPress={() => onSelect(tab)}
          style={
            wide
              ? [
                  s.navItem,
                  compact && s.compactNav,
                  view === tab && s.navSelected,
                ]
              : [s.tab, view === tab && s.navSelected]
          }
        >
          <Icon
            name={tab.toLowerCase()}
            color={view === tab ? c.accent : c.mute}
          />
          {!compact && (
            <Text
              style={[
                wide ? s.navLabel : s.caption,
                view === tab && s.active,
                !wide && view === tab && s.tabSelectedLabel,
              ]}
            >
              {tab}
            </Text>
          )}
        </Pressable>
      ))}
      {wide && !compact && (
        <View style={s.navFooter}>
          <Text style={s.caption}>
            {hub ? "Hub connected" : "Disconnected"}
          </Text>
        </View>
      )}
    </Container>
  );
}

export function MachineRow({
  name,
  description,
  role = "Replica",
  totals,
  self,
  hub,
  state,
  actions,
}) {
  const { s, c, wide } = useDesign();
  return (
    <View
      style={[s.card, s.machineRow]}
      accessibilityLabel={`${name}, ${role}${self ? ", this machine" : ""}, ${description}${state ? `, ${state}` : ""}`}
    >
      <View style={s.row}>
        <View style={[s.tile, s.machineTile, hub && s.hubTile]}>
          <Icon
            color={hub ? c.onAccent : undefined}
            name={
              hub
                ? "server"
                : /android|ios|iphone/i.test(description)
                  ? "phone"
                  : "monitor"
            }
          />
        </View>
        <View style={[s.flex, s.stack]}>
          <View style={s.machineIdentity}>
            <Text numberOfLines={1} style={[s.rowTitle, s.machineName]}>
              {name}
            </Text>
            <Tag variant={hub ? "hub" : undefined}>{role.toUpperCase()}</Tag>
            {self && <Tag variant="self">THIS MACHINE</Tag>}
          </View>
          <Text numberOfLines={1} style={wide ? s.mono : s.caption}>
            {description}
          </Text>
        </View>
        {wide && (
          <View style={s.machineEnd}>
            {!!state && <Badge>{state}</Badge>}
            {!!totals && <Text style={s.caption}>{totals}</Text>}
          </View>
        )}
        {actions}
      </View>
    </View>
  );
}

export function SettingsGroup({ children }) {
  const { s } = useDesign();
  return (
    <View style={s.group}>
      {React.Children.toArray(children).map((child, index) =>
        React.cloneElement(child, { grouped: true, divider: index > 0 }),
      )}
    </View>
  );
}

export function SegmentedControl({ options, value, onChange }) {
  const { s } = useDesign();
  return (
    <View style={s.segments}>
      {options.map((option) => (
        <Pressable
          key={option.value}
          accessibilityRole="button"
          accessibilityState={{ selected: value === option.value }}
          onPress={() => onChange(option.value)}
          style={[s.segment, value === option.value && s.segmentSelected]}
        >
          <Text
            style={[
              s.buttonLabel,
              s.segmentText,
              value === option.value && s.segmentTextSelected,
            ]}
          >
            {option.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

// Approval is composed from the shared sheet, reference panel, rows and controls.
export function ApprovalSheet({ request, hubName, busy, error, onDecision }) {
  const { s, c } = useDesign();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.ceil((request.expires - now) / 1000));
  const remaining = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const age = Math.max(0, Math.floor((now - request.created) / 60000));
  const requested = age > 0 ? `${age} min ago` : "Just now";
  return (
    <Sheet onClose={() => onDecision("deny")} busy={busy}>
      <Icon name="login" size={28} color={c.accent} />
      <Text accessibilityRole="header" style={s.approvalTitle}>
        Allow this browser to open {hubName}?
      </Text>
      <Text style={s.text}>
        Someone is signing in to the hub web. Allow it only if that is you,
        right now.
      </Text>
      <View style={s.requestReference}>
        <Text style={[s.eyebrow, s.centerText]}>
          REQUEST · must match the browser
        </Text>
        <Text accessibilityLabel={request.reference} style={s.requestNumber}>
          {request.reference.slice(0, 3)}
          <Text style={s.requestSeparator}> – </Text>
          {request.reference.slice(3)}
        </Text>
      </View>
      <View style={s.group}>
        {[
          ["globe", "Browser", request.browser || "Browser"],
          ["shield", "From", request.ip],
          ["clock", "Requested", `${requested} · expires in ${remaining}`],
        ].map(([icon, label, value], index) => (
          <View
            key={label}
            style={[s.approvalRow, index > 0 && s.approvalRowBorder]}
          >
            <Icon name={icon} />
            <Text style={s.text}>{label}</Text>
            <Text style={[s.heading, s.approvalValue]}>{value}</Text>
          </View>
        ))}
      </View>
      <Text style={s.caption}>
        Grants a 24-hour session on that browser. Browser details are reported
        by the requester.
      </Text>
      {!!error && (
        <Text accessibilityRole="alert" style={s.caption}>
          {error}
        </Text>
      )}
      <View style={s.row}>
        <View style={s.flex}>
          <Button
            label="Deny"
            disabled={busy}
            onPress={() => onDecision("deny")}
          />
        </View>
        <View style={s.flex}>
          <Button
            primary
            label="Allow"
            disabled={busy || seconds === 0}
            onPress={() => onDecision("allow")}
          />
        </View>
      </View>
    </Sheet>
  );
}
