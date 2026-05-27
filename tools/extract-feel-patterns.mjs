import { openDb, getDb } from "../dist/db/connection.js";
openDb();
const db = getDb();
const patterns = db.prepare(`
  SELECT f.summary FROM fragments f
  JOIN fragment_anchors fa ON fa.fragment_id = f.id
  WHERE f.project_id = @pid AND f.status = 'active' AND fa.channel = 'FEEL'
    AND fa.weight >= 80
    AND (f.summary LIKE @p1 OR f.summary LIKE @p2 OR f.summary LIKE @p3
      OR f.summary LIKE @p4 OR f.summary LIKE @p5 OR f.summary LIKE @p6
      OR f.summary LIKE @p7 OR f.summary LIKE @p8 OR f.summary LIKE @p9)
  ORDER BY fa.weight DESC
`).all({
  pid: "C--Users-Administrator",
  p1: "%必须%", p2: "%不要%", p3: "%铁律%",
  p4: "%禁止%", p5: "%纠正%", p6: "%永远%",
  p7: "%不得%", p8: "%不应%", p9: "%不可%"
}).map(r => r.summary);
console.log(JSON.stringify(patterns));
