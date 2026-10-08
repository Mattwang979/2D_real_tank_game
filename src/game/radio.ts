// Team radio: quick commands with map pings. Human commands also steer the AI teammates
// (attack / defend the point, come and help, follow, go to a ping), who answer on the radio.

export type RadioPing = 'cap' | 'self' | 'aim' | 'map';
export type RadioOrder = 'attack' | 'defend' | 'help' | 'follow' | 'goto';

export interface RadioCmd {
  id: string;
  /** what gets said (i18n key) */
  text: string;
  /** short label for the menu button (i18n key) */
  label: string;
  /** where the map ping goes */
  ping?: RadioPing;
  /** what the AI teammates do about it */
  order?: RadioOrder;
  /** shown in the radio menu */
  menu: boolean;
}

/** Index in this list is what goes over the network. */
export const RADIO: RadioCmd[] = [
  { id: 'attack', text: 'Attack point A!', label: 'Attack A', ping: 'cap', order: 'attack', menu: true },
  { id: 'defend', text: 'Defend point A!', label: 'Defend A', ping: 'cap', order: 'defend', menu: true },
  { id: 'help', text: 'I need help!', label: 'Help me', ping: 'self', order: 'help', menu: true },
  { id: 'enemy', text: 'Enemy spotted there!', label: 'Enemy there', ping: 'aim', order: 'goto', menu: true },
  { id: 'follow', text: 'Follow me!', label: 'Follow me', ping: 'self', order: 'follow', menu: true },
  { id: 'yes', text: 'Affirmative!', label: 'Affirmative', menu: true },
  { id: 'no', text: 'Negative!', label: 'Negative', menu: true },
  { id: 'thanks', text: 'Thanks!', label: 'Thanks', menu: true },
  { id: 'ping', text: 'Look here!', label: 'Ping', ping: 'map', order: 'goto', menu: false },
  { id: 'omw', text: 'On my way!', label: 'On my way', menu: false },
];

export const radioIndex = (id: string) => RADIO.findIndex((c) => c.id === id);

/** minimum seconds between two radio calls from the same tank */
export const RADIO_GAP = 1.4;
/** how long a map ping stays up (s) */
export const PING_LIFE = 6;
