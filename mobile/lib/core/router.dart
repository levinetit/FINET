import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../features/auth/intro_screen.dart';
import '../features/auth/login_screen.dart';
import '../features/auth/session.dart';
import '../features/auth/session_screens.dart';
import '../features/budgets/budgets_screen.dart';
import '../features/recurring/recurring_screen.dart';
import '../features/receipts/matches_screen.dart';
import '../features/receipts/receipt_review_screen.dart';
import '../features/receipts/receipts_screen.dart';
import '../features/scan/upload_status_screen.dart';
import '../features/scan/media.dart';
import '../features/share/share_screens.dart';
import '../features/statements/import_screen.dart';
import '../features/statements/preview_screen.dart';
import '../features/statements/statements_screen.dart';
import '../features/finance/models.dart';
import '../features/home/home_screen.dart';
import '../features/more/more_screen.dart';
import '../features/profile/profile_screen.dart';
import '../features/reports/reports_screen.dart';
import '../features/scan/scan_screen.dart';
import '../features/settings/settings_controller.dart';
import '../features/settings/settings_screen.dart';
import '../features/transactions/transaction_form.dart';
import '../features/transactions/transactions_screen.dart';
import '../features/update/update_controller.dart';
import '../features/update/update_widgets.dart';
import '../features/usage/usage_tracker.dart';
import 'providers.dart';

const _gateRoutes = {'/splash', '/intro', '/login', '/unavailable'};

/// Unde trebuie să fie utilizatorul, după starea aplicației; `null` = rămâne unde e.
///
/// Ordinea: ecranul de informare de la prima pornire, apoi verificarea sesiunii, apoi login.
/// Cu sesiune activă, ecranele de poartă (login, intro, splash) duc la Acasă.
String? redirectFor({
  required String location,
  required SessionState session,
  required bool introSeen,
  bool updateRequired = false,
}) {
  String? go(String target) => location == target ? null : target;
  if (!introSeen) return go('/intro');
  return switch (session) {
    SessionLoading() => go('/splash'),
    SessionUnavailable() => go('/unavailable'),
    SignedOut() => go('/login'),
    // Versiune sub minimul serverului: nicio funcție financiară până la actualizare.
    SignedIn() when updateRequired => go('/update-required'),
    SignedIn() => _gateRoutes.contains(location) ? '/' : null,
  };
}

/// Reîmprospătează routerul când se schimbă sesiunea sau setările.
class _RouterRefresh extends ChangeNotifier {
  _RouterRefresh(Ref ref) {
    ref
      ..listen<SessionState>(sessionProvider, (_, _) => notifyListeners())
      ..listen(settingsProvider, (_, _) => notifyListeners())
      ..listen(updateControllerProvider, (_, _) => notifyListeners());
  }
}

/// Rutele aplicației: porțile (intro, login, splash), navigarea de jos cu cinci ramuri (Acasă,
/// Tranzacții, Scanează, Rapoarte, Mai mult), apoi Profil și Setări.
final routerProvider = Provider<GoRouter>((ref) {
  final refresh = _RouterRefresh(ref);
  final router = GoRouter(
    initialLocation: '/splash',
    refreshListenable: refresh,
    redirect: (context, state) => redirectFor(
      location: state.matchedLocation,
      session: ref.read(sessionProvider),
      introSeen: ref.read(settingsProvider).introSeen,
      updateRequired: ref
          .read(updateControllerProvider.notifier)
          .updateRequired,
    ),
    routes: [
      GoRoute(path: '/splash', builder: (_, _) => const SplashScreen()),
      GoRoute(path: '/intro', builder: (_, _) => const IntroScreen()),
      GoRoute(path: '/login', builder: (_, _) => const LoginScreen()),
      GoRoute(
        path: '/unavailable',
        builder: (_, _) => const SessionUnavailableScreen(),
      ),
      GoRoute(
        path: '/update-required',
        builder: (_, _) => const UpdateRequiredScreen(),
      ),
      GoRoute(path: '/profile', builder: (_, _) => const ProfileScreen()),
      GoRoute(path: '/settings', builder: (_, _) => const SettingsScreen()),
      GoRoute(path: '/budgets', builder: (_, _) => const BudgetsScreen()),
      GoRoute(path: '/recurring', builder: (_, _) => const RecurringScreen()),
      GoRoute(
        path: '/scan/status',
        builder: (_, _) => const UploadStatusScreen(),
      ),
      GoRoute(path: '/receipts', builder: (_, _) => const ReceiptsScreen()),
      GoRoute(
        path: '/receipts/:id',
        builder: (_, state) =>
            ReceiptReviewScreen(receiptId: state.pathParameters['id']!),
      ),
      GoRoute(path: '/matches', builder: (_, _) => const MatchesScreen()),
      GoRoute(
        path: '/share/pdf',
        // Fișierul vine ca `extra`; fără el (după repornire) nu e nimic de importat.
        redirect: (_, state) => state.extra is PickedMedia ? null : '/scan',
        builder: (_, state) =>
            SharedPdfScreen(file: state.extra! as PickedMedia),
      ),
      GoRoute(
        path: '/share/unsupported',
        builder: (_, _) => const SharedUnsupportedScreen(),
      ),
      GoRoute(path: '/statements', builder: (_, _) => const StatementsScreen()),
      GoRoute(
        path: '/statements/import',
        builder: (_, state) => StatementImportScreen(
          shared: state.extra is PickedMedia
              ? state.extra! as PickedMedia
              : null,
        ),
      ),
      GoRoute(
        path: '/statements/:id',
        builder: (_, state) =>
            StatementPreviewScreen(importId: state.pathParameters['id']!),
      ),
      GoRoute(
        path: '/transactions/new',
        builder: (_, _) => const TransactionFormScreen(),
      ),
      GoRoute(
        path: '/transactions/edit',
        // Tranzacția vine ca `extra`; fără ea (de exemplu după repornire) se revine la listă.
        redirect: (_, state) =>
            state.extra is FinTransaction ? null : '/transactions',
        builder: (_, state) =>
            TransactionFormScreen(existing: state.extra! as FinTransaction),
      ),
      StatefulShellRoute.indexedStack(
        builder: (context, state, shell) => _Shell(shell: shell),
        branches: [
          StatefulShellBranch(
            routes: [GoRoute(path: '/', builder: (_, _) => const HomeScreen())],
          ),
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: '/transactions',
                builder: (_, _) => const TransactionsScreen(),
              ),
            ],
          ),
          StatefulShellBranch(
            routes: [
              GoRoute(path: '/scan', builder: (_, _) => const ScanScreen()),
            ],
          ),
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: '/reports',
                builder: (_, _) => const ReportsScreen(),
              ),
            ],
          ),
          StatefulShellBranch(
            routes: [
              GoRoute(path: '/more', builder: (_, _) => const MoreScreen()),
            ],
          ),
        ],
      ),
    ],
  );
  ref.onDispose(() {
    router.dispose();
    refresh.dispose();
  });
  return router;
});

/// Ecranul raportat la `screen_view` pentru fiecare tab (același ca în lista serverului).
const _tabScreens = [
  UsageScreens.dashboard,
  UsageScreens.transactions,
  UsageScreens.scan,
  UsageScreens.reports,
  UsageScreens.settings,
];

class _Shell extends ConsumerStatefulWidget {
  const _Shell({required this.shell});
  final StatefulNavigationShell shell;

  @override
  ConsumerState<_Shell> createState() => _ShellState();
}

class _ShellState extends ConsumerState<_Shell> {
  @override
  void initState() {
    super.initState();
    ref
        .read(usageTrackerProvider)
        .screen(_tabScreens[widget.shell.currentIndex]);
  }

  @override
  Widget build(BuildContext context) {
    final shell = widget.shell;
    return Scaffold(
      body: shell,
      bottomNavigationBar: NavigationBar(
        selectedIndex: shell.currentIndex,
        onDestinationSelected: (i) {
          if (i != shell.currentIndex) {
            ref.read(usageTrackerProvider).screen(_tabScreens[i]);
          }
          shell.goBranch(i, initialLocation: i == shell.currentIndex);
        },
        destinations: const [
          NavigationDestination(
            icon: Icon(Icons.home_outlined),
            selectedIcon: Icon(Icons.home),
            label: 'Acasă',
          ),
          NavigationDestination(
            icon: Icon(Icons.swap_vert),
            selectedIcon: Icon(Icons.swap_vert),
            label: 'Tranzacții',
          ),
          NavigationDestination(
            icon: Icon(Icons.document_scanner_outlined),
            selectedIcon: Icon(Icons.document_scanner),
            label: 'Scanează',
          ),
          NavigationDestination(
            icon: Icon(Icons.bar_chart_outlined),
            selectedIcon: Icon(Icons.bar_chart),
            label: 'Rapoarte',
          ),
          NavigationDestination(
            icon: Icon(Icons.more_horiz),
            selectedIcon: Icon(Icons.more_horiz),
            label: 'Mai mult',
          ),
        ],
      ),
    );
  }
}
