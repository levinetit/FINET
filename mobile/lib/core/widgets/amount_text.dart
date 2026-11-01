import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../money/format.dart';
import '../money/money.dart';
import '../state/privacy.dart';
import '../theme/theme.dart';
import '../theme/tokens.dart';

/// Textul afișat în locul unei sume ascunse.
const String hiddenAmount = '••••';

/// Suma ca text: formatată sau „••••” când sumele sunt ascunse. Orice text care conține o sumă
/// (nu doar [AmountText]) trebuie să treacă pe aici, ca ascunderea să fie completă.
String displayMoney(Money money, {required bool hidden}) =>
    hidden ? hiddenAmount : formatMoney(money);

/// Suma formatată românește, în IBM Plex Mono cu cifre tabulare. Veniturile sunt verzi, iar
/// cheltuielile roșii doar când [signed] e `true` (suma are semn). Respectă comutatorul „ascunde
/// sumele”.
class AmountText extends ConsumerWidget {
  const AmountText(
    this.money, {
    super.key,
    this.size = 15,
    this.bold = false,
    this.signed = false,
  });

  final Money money;
  final double size;
  final bool bold;
  final bool signed;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final hidden = ref.watch(hideAmountsProvider);
    final c = context.finet;
    final color = !signed
        ? c.fg
        : money.isNegative
        ? c.bad
        : money.isZero
        ? c.fg
        : c.ok;
    return Text(
      hidden ? hiddenAmount : formatMoney(money),
      semanticsLabel: hidden ? 'sumă ascunsă' : null,
      style: amountStyle(size, bold: bold).copyWith(color: color),
    );
  }
}
