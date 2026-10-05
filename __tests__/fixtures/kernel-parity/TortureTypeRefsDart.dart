import 'report.dart';

// #2327 type positions + #2338 getter reads, for kernel/wasm parity.
Report? current;
final Report seeded = Report(1);
late List<Report> history;
final reportProvider = Family<Report?, String>();
const Map<String, Report> byName = {};

extension ReportX on Report {
  bool get high => score > 5;
}

extension ListX<T> on List<Map<String, Report>> {}

extension on Holder {
  int get twice => 2;
}

class Family<T, A> {
  const Family();
}

class Holder {
  final Report report;
  late final List<Report?> older;
  Map<String, Report>? index;
  final cache = Family<Report, int>();
  static final shared = Family<Holder, Report>();
  const Holder(this.report);

  int get area => report.score * 2;

  void bump(Holder other) {
    final List<Report> xs = <Report>[];
    other.report;
    other?.area;
    other.area.toString();
    other.bump(this);
    this.area;
    print(other.report.score);
    other.area = 3;
    Future<Report?>.value(null);
    xs.map<Holder>((r) => Holder(r));
  }
}

void run(Holder h) {
  Future<Report?>.value(null);
  h.area;
  h.Type;
  void inner() {
    h.report;
    List<Report>.empty();
  }
  inner();
}
