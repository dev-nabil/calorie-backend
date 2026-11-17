import { coachLanguageDirective, latinLanguage, messageScript } from './language';

describe('coach reply language', () => {
  it('names the script of a clear message; no signal for numbers, "ok", emoji or a single short word', () => {
    expect(messageScript('ami sokale 2 ta ruti ar ekta dim bhaji kheyechi')).toBe('Latin');
    expect(messageScript('আমার ডায়াবেটিস আছে, আমি কি আম খেতে পারি?')).toBe('Bengali');
    expect(messageScript('আমি ২০০ গ্রাম কাঁচা রাজমা ভিজিয়ে খেয়েছি')).toBe('Bengali');
    expect(messageScript('مرحبا كيف أزيد البروتين')).toBe('Arabic');
    expect(messageScript('मुझे वजन कम करना है')).toBe('Devanagari');
    for (const none of ['ok 👍', '250', 'dal', 'ভাত', '']) expect(messageScript(none)).toBeNull();
  });

  it('a Bangla-script question after a Banglish reply is answered in Bengali script, and Banglish in Latin letters', () => {
    // Live run 16 Nov: both drifted to the script of the previous reply or of the card's food names.
    const bn = coachLanguageDirective('bn', 'Sokaler nashtay dim 2 ti deoyay ekhon', 'আমার ডায়াবেটিস আছে, আমি কি আম খেতে পারি?');
    expect(bn).toContain('written in Bengali script');
    const banglish = coachLanguageDirective('bn', 'আপনার দুপুরের খাবারটি', 'ami sokale 2 ta ruti ar ekta dim bhaji kheyechi');
    expect(banglish).toContain('written in Latin letters');
    expect(coachLanguageDirective('bn', 'আপনার দুপুরের খাবারটি', 'ok 👍')).not.toContain('written in');
  });

  it('tells English from Banglish in Latin letters by their small words; unsure stays null', () => {
    expect(latinLanguage('What can I eat for dinner tonight?')).toBe('English');
    expect(latinLanguage('give me some high protein snack ideas')).toBe('English');
    expect(latinLanguage('ami sokale 2 ta ruti ar ekta dim bhaji kheyechi')).toBe('Banglish');
    expect(latinLanguage('ajke rate ki khabo?')).toBe('Banglish');
    for (const none of ['chicken biryani', 'ok', 'dal bhat']) expect(latinLanguage(none)).toBeNull();
  });

  it('an English question after Banglish turns gets English names: the interpret step reads the same rule', () => {
    // Device test 16 Nov: suggestion names came out in Banglish for "what can I eat for dinner?" after Banglish turns.
    const d = coachLanguageDirective('bn', 'Apnar dupurer khabar ta valo chilo', 'What can I eat for dinner tonight?');
    expect(d).toContain('This message is in English');
    expect(d).toContain('food and dish names');
    expect(coachLanguageDirective('bn', 'Apnar dupurer khabar', 'ajke rate ki khabo bolo to')).toContain('This message is in Banglish');
  });
});
