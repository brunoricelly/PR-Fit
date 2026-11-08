import { professionalText as p } from '../../src/lib/professional-copy.js'

export default function Fixture() {
  return <><button aria-label="Back">Try again</button><input placeholder="HH:MM" />{t('Translated')}{p('My athletes')}{p('Untranslated professional action')}</>
}
