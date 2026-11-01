import 'package:flutter/material.dart';

import '../update/update_widgets.dart';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/money/format.dart';
import '../../core/money/money.dart';
import '../../core/state/privacy.dart';
import '../../core/theme/tokens.dart';
import '../../core/widgets/amount_text.dart';
import '../../core/widgets/async_view.dart';
import '../../core/widgets/finet_scaffold.dart';
import '../../core/widgets/month_selector.dart';
import '../../core/widgets/states.dart';
import '../finance/models.dart';
import '../finance/providers.dart';

/// Acasă: sumarul lunii pe monedă (venituri, cheltuieli, net, număr de tranzacții, comparația cu
/// luna anterioară, categorii, evoluție) și conturile cu solduri. Toate cifrele vin de la server
/// (`GET /api/v1/dashboard`, `GET /api/v1/accounts`); aplicația doar le formatează.
class HomeScreen extends ConsumerWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final month = ref.watch(selectedMonthProvider);
    final dashboard = ref.watch(dashboardProvider(month));
    final accounts = ref.watch(accountsProvider);
    return FinetScaffold(
      title: 'Acasă',
      body: RefreshIndicator(
        onRefresh: () async {
          ref
            ..invalidate(dashboardProvider)
            ..invalidate(accountsProvider);
          try {
            await ref.read(dashboardProvider(month).future);
          } on Object {
            // Eroarea se vede în ecran, cu „Încearcă din nou”.
          }
        },
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            const UpdateBanner(),
            const MonthSelector(),
            const SizedBox(height: 8),
            AsyncView<DashboardData>(
              value: dashboard,
              onRetry: () => ref.invalidate(dashboardProvider),
              data: (d) => _DashboardBody(data: d),
            ),
            const SizedBox(height: 24),
            AsyncView<AccountsResult>(
              value: accounts,
              onRetry: () => ref.invalidate(accountsProvider),
              data: (a) => _AccountsCard(result: a),
            ),
          ],
        ),
      ),
    );
  }
}

class _DashboardBody extends StatelessWidget {
  const _DashboardBody({required this.data});
  final DashboardData data;

  @override
  Widget build(BuildContext context) {
    if (!data.hasAccount) {
      return const EmptyState(
        title: 'Nu ai încă niciun cont',
        message: 'Adaugă un cont în aplicația web, apoi revino aici.',
      );
    }
    if (data.currencies.isEmpty) {
      return const EmptyState(
        title: 'Nicio tranzacție în această lună',
        message: 'Adaugă o tranzacție din tabul Tranzacții.',
      );
    }
    return Column(
      children: [
        for (final c in data.currencies) _CurrencySection(dashboard: c),
      ],
    );
  }
}

class _CurrencySection extends StatelessWidget {
  const _CurrencySection({required this.dashboard});
  final CurrencyDashboard dashboard;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final c = context.finet;
    final d = dashboard;
    final maxCategory = d.byCategory.fold<int>(
      1,
      (m, e) => e.amountMinor > m ? e.amountMinor : m,
    );
    return Padding(
      padding: const EdgeInsets.only(bottom: 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Sold net (${d.currency.code})',
                    style: text.labelMedium?.copyWith(color: c.muted),
                  ),
                  const SizedBox(height: 4),
                  AmountText(
                    d.money(d.totals.netMinor),
                    size: 28,
                    bold: true,
                    signed: true,
                  ),
                  _ChangeLine(change: d.net, money: d.money),
                  const SizedBox(height: 16),
                  Row(
                    children: [
                      Expanded(
                        child: _Figure(
                          label: 'Venituri',
                          money: d.money(d.totals.incomeMinor),
                          change: d.income,
                        ),
                      ),
                      Expanded(
                        child: _Figure(
                          label: 'Cheltuieli',
                          money: d.money(-d.totals.expenseMinor),
                          change: d.expense,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  Text(
                    '${d.totals.transactionCount} tranzacții în această lună',
                    style: text.bodySmall?.copyWith(color: c.muted),
                  ),
                ],
              ),
            ),
          ),
          if (d.byCategory.isNotEmpty) ...[
            const SizedBox(height: 16),
            Text('Cheltuieli pe categorii', style: text.titleMedium),
            const SizedBox(height: 8),
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  children: [
                    for (final (i, cat) in d.byCategory.indexed) ...[
                      _CategoryBar(
                        share: cat,
                        money: d.money(cat.amountMinor),
                        fraction: cat.amountMinor / maxCategory,
                      ),
                      if (i != d.byCategory.length - 1)
                        const SizedBox(height: 12),
                    ],
                  ],
                ),
              ),
            ),
          ],
          if (d.monthly.length > 1) ...[
            const SizedBox(height: 16),
            Text('Evoluție lunară', style: text.titleMedium),
            const SizedBox(height: 8),
            _MonthlyBars(points: d.monthly, currency: d.currency),
          ],
        ],
      ),
    );
  }
}

/// „+12% față de luna trecută”; fără procent când luna trecută a fost zero.
class _ChangeLine extends ConsumerWidget {
  const _ChangeLine({required this.change, required this.money});
  final Change change;
  final Money Function(int) money;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final hidden = ref.watch(hideAmountsProvider);
    final p = change.percent;
    final sign = change.diffMinor > 0 ? '+' : '';
    final diff = displayMoney(money(change.diffMinor), hidden: hidden);
    final label = p == null
        ? 'față de luna trecută: ${change.diffMinor == 0 ? 'fără schimbare' : '$sign$diff'}'
        : '$sign$p% față de luna trecută';
    return Padding(
      padding: const EdgeInsets.only(top: 2),
      child: Text(
        label,
        style: Theme.of(context).textTheme.bodySmall
            ?.copyWith(color: context.finet.muted),
      ),
    );
  }
}

class _Figure extends StatelessWidget {
  const _Figure({
    required this.label,
    required this.money,
    required this.change,
  });
  final String label;
  final Money money;
  final Change change;

  @override
  Widget build(BuildContext context) {
    final p = change.percent;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: Theme.of(context).textTheme.labelMedium
              ?.copyWith(color: context.finet.muted),
        ),
        const SizedBox(height: 2),
        AmountText(money, signed: true, bold: true),
        if (p != null)
          Text(
            '${p > 0 ? '+' : ''}$p%',
            style: Theme.of(context).textTheme.bodySmall
                ?.copyWith(color: context.finet.muted),
          ),
      ],
    );
  }
}

class _CategoryBar extends StatelessWidget {
  const _CategoryBar({
    required this.share,
    required this.money,
    required this.fraction,
  });
  final CategoryShare share;
  final Money money;
  final double fraction;

  @override
  Widget build(BuildContext context) {
    final c = context.finet;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                share.name,
                style: Theme.of(context).textTheme.bodyMedium,
              ),
            ),
            const SizedBox(width: 8),
            // La fonturi mari suma se micșorează, nu iese din ecran.
            Flexible(
              child: FittedBox(
                fit: BoxFit.scaleDown,
                alignment: Alignment.centerRight,
                child: AmountText(money, size: 14),
              ),
            ),
            const SizedBox(width: 8),
            Text(
              '${share.percent}%',
              style: Theme.of(context).textTheme.bodySmall
                  ?.copyWith(color: c.muted),
            ),
          ],
        ),
        const SizedBox(height: 6),
        ClipRRect(
          borderRadius: BorderRadius.circular(4),
          child: LinearProgressIndicator(
            value: fraction.clamp(0.0, 1.0),
            minHeight: 6,
            backgroundColor: c.line,
            color: share.isOther ? c.muted : c.accent,
            semanticsLabel: share.name,
          ),
        ),
      ],
    );
  }
}

/// Evoluția lunară: bare pentru cheltuieli, scalate la maximul din interval (desen, nu calcul
/// financiar; valorile exacte sunt cele de la server).
class _MonthlyBars extends ConsumerWidget {
  const _MonthlyBars({required this.points, required this.currency});
  final List<MonthPoint> points;
  final Currency currency;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final hidden = ref.watch(hideAmountsProvider);
    final c = context.finet;
    final maxExpense = points.fold<int>(
      1,
      (m, p) => p.expenseMinor > m ? p.expenseMinor : m,
    );
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          children: [
            for (final p in points)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 4),
                child: Semantics(
                  label:
                      '${formatMonth(p.month.firstDay)}: cheltuieli '
                      '${displayMoney(Money(p.expenseMinor, currency), hidden: hidden)}',
                  child: Row(
                    children: [
                      SizedBox(
                        width: 84,
                        child: Text(
                          formatMonth(p.month.firstDay).split(' ').first,
                          style: Theme.of(context).textTheme.bodySmall
                              ?.copyWith(color: c.muted),
                        ),
                      ),
                      Expanded(
                        child: ClipRRect(
                          borderRadius: BorderRadius.circular(4),
                          child: LinearProgressIndicator(
                            value: (p.expenseMinor / maxExpense).clamp(
                              0.0,
                              1.0,
                            ),
                            minHeight: 8,
                            backgroundColor: c.line,
                            color: c.accent,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _AccountsCard extends StatelessWidget {
  const _AccountsCard({required this.result});
  final AccountsResult result;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final accounts = result.accounts.where((a) => !a.archived).toList();
    if (accounts.isEmpty) return const SizedBox.shrink();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Conturi', style: text.titleMedium),
        const SizedBox(height: 8),
        Card(
          child: Column(
            children: [
              for (final (i, a) in accounts.indexed) ...[
                ListTile(
                  title: Text(a.name),
                  subtitle: Text(a.type.label),
                  trailing: AmountText(a.balance, signed: true, bold: true),
                ),
                if (i != accounts.length - 1) const Divider(),
              ],
              for (final t in result.totals) ...[
                const Divider(),
                ListTile(
                  title: Text(
                    'Total ${t.currency.code}',
                    style: text.titleSmall,
                  ),
                  trailing: AmountText(t, signed: true, bold: true),
                ),
              ],
            ],
          ),
        ),
      ],
    );
  }
}
