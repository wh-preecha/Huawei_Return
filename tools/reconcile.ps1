param([string]$Src = '', [string]$Out = 'C:\Users\krisprasert_k\Downloads\reconciled_cases.json')
$ErrorActionPreference='Stop'
# ---- Huawei Return: reconcile legacy Excel -> reconciled_cases.json
# v4: header map + row-level repair + normalisation + CN stage + follow-up fields + date swap guard + CIV-first dedupe
# v5 (G01-G03, parity with the app's in-page Excel import):
#   - Imp-Key: a match key must contain a digit and must not look like a broken scientific number ('E+'),
#     applied to invoice/order before lookup and registration (placeholder text such as 'HUAWEI' is never a key)
#   - Pick-Inv: invoice column used only for CIV/IV numbers; a multi-invoice cell ('IV.../CIV...') keys on the first CIV.
#     A PA number in the invoice column moves to paNo (when empty); other numeric text is kept in remark ('Invoice ในไฟล์: ...')
#   - Norm-Key strips whitespace and '-' (app normKey)
#   - To-ISODate = app impDate (y-m-d, repeated separators '01/11//2025', 2-digit Buddhist years '69' -> 2026,
#     Excel serial text, English month names, a date-separator before a 4-digit year is not a y-m-d start)
#   - G02: stockDate < receivedDate and the receivedDate day <= 12 and the swapped date <= stockDate -> swap receivedDate,
#     original kept in remark ('วันที่เดิม: ...'); otherwise kept as is (shown under 'วันที่ผิดปกติ' in the app)
#   - merge (duplicate rows) also fills blank serial and qty
$CULT=[Globalization.CultureInfo]::InvariantCulture
$src=$Src
if(-not $src){ $src=(Get-ChildItem 'C:\Users\krisprasert_k\Downloads' -Filter '*market place*CN (1).xlsx' | Select-Object -First 1).FullName }
if(-not $src){ $src=(Get-ChildItem 'C:\Users\krisprasert_k\Downloads' -Filter '*market place*CN*.xlsx' | Sort-Object Length -Descending | Select-Object -First 1).FullName }
$out=$Out
$TODAY=(Get-Date).Date
$TODAYS=$TODAY.ToString('yyyy-MM-dd',$CULT)

# field -> ordered synonyms (earlier synonym wins; matched against the lower-cased header text)
$FIELDS=@('receivedDate','invoiceNo','paNo','orderNo','platform','sku','serial','qty','condition','tracking','reason','ccNo','remark','stockDate','handover','claimDate')
$SYN=@{
  receivedDate=@('วันที่ได้รับ','date','วันที่')
  invoiceNo=@('civ','invoice')
  paNo=@('เลขที่บิล','order no')
  orderNo=@('reference','order number','order')
  platform=@('channel','platflom','platform')
  sku=@('sku')
  serial=@('serialno','serial','sn')
  qty=@('return quantity','quantity','จำนวน')
  condition=@('product condition','สภาพสินค้า','สภาพ')
  tracking=@('tracking')
  reason=@('issue','เหตุผล')
  ccNo=@('อีฟกด cc','cc')
  remark=@('remark','หมายเหตุ')
  stockDate=@('แจ้งอีฟ')
  handover=@('วันที่คืนคลัง','นำสินค้าส่ง')
  claimDate=@('วันที่เคลม')
}
$CARRIERS=@('J&T','FLASH','SPX','Shopee Xpress','LEX','KERRY','EMS','Thaipost','DHL','KEX','Lazada')
# status rank: most advanced wins when the same case is found in several sheets
$RANK=@{'สร้างคำขอคืน'=0;'รอรับสินค้า'=1;'ได้รับสินค้าแล้ว'=2;'รอทดสอบ'=3;'กำลังทดสอบ'=4;'ทดสอบเสร็จ'=5;'เคลม Platform'=6;'ส่งคืนลูกค้า'=7;'รอทำรับคืน (CN)'=8;'ปิดงาน'=9}
function Stage-Rank($s){ if($RANK.ContainsKey($s)){ return $RANK[$s] }; return 0 }

function Get-Str($v){ if($null -eq $v){return ''}; if($v -is [double]){ if([Math]::Abs($v) -ge 1e11){ return ([decimal]$v).ToString('0') } }; return ([string]$v).Trim() }

# ---- dates: port of the app's impDate (YYYY-MM-DD, '' = unreadable). Years 2019-2035; a date later than today is
# almost always a day/month swap made at data entry: swap it back when that gives a real date not after today, else drop it.
function Ok-Date([int]$y,[int]$mo,[int]$d){
  if($y -lt 2019 -or $y -gt 2035 -or $mo -lt 1 -or $mo -gt 12 -or $d -lt 1){ return '' }
  if($d -gt [DateTime]::DaysInMonth($y,$mo)){ return '' }
  return ('{0:D4}-{1:D2}-{2:D2}' -f $y,$mo,$d)
}
function Pick-Date([int]$y,[int]$mo,[int]$d){
  $r=Ok-Date $y $mo $d
  if($r -and [string]::CompareOrdinal($r,$TODAYS) -le 0){ return $r }
  if($d -le 12){ $sw=Ok-Date $y $d $mo; if($sw -and [string]::CompareOrdinal($sw,$TODAYS) -le 0){ return $sw } }
  return ''
}
# 2-digit year: >= 50 is Buddhist era (69 -> 2026), else 20xx; 4-digit Buddhist era -543
function Yr([int]$y){ if($y -lt 100){ if($y -ge 50){ $y+=1957 } else { $y+=2000 } }; if($y -gt 2400){ $y-=543 }; return $y }
$MONRX='^(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?)$'
$MONS=@('jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec')
function Mon-No($w){ if("$w" -match $MONRX){ return ([array]::IndexOf($MONS,"$w".Substring(0,3).ToLower())+1) }; return 0 }
function To-ISODate($v){
  if($null -eq $v -or $v -eq ''){return ''}
  if($v -is [DateTime]){ return (Pick-Date $v.Year $v.Month $v.Day) }
  if($v -is [double]){ if($v -gt 40000 -and $v -lt 60000){ try{ $t=[DateTime]::FromOADate($v); return (Pick-Date $t.Year $t.Month $t.Day) }catch{ return '' } }; return '' }
  $s=([string]$v).Trim()
  # Excel serial number as text
  if($s -match '^[0-9]{5}(\.[0-9]+)?$'){ $n=[double]::Parse($s,$CULT); if($n -gt 40000 -and $n -lt 60000){ $t=[DateTime]::FromOADate($n); return (Pick-Date $t.Year $t.Month $t.Day) }; return '' }
  # first date inside the text, y-m-d or d/m/y, separators may repeat ('01/11//2025'); d/m/y is searched in the text with the
  # y-m-d part blanked out, so '10-22' is not read from the middle of '2024-10-22'; a 4-digit year right after a date
  # separator is not a y-m-d start ('20/08/2025-21/08/2025' -> 2025-08-20)
  $mi=[regex]::Match($s,'(?:^|[^0-9/\-.])([0-9]{4})[/\-.]+([0-9]{1,2})[/\-.]+([0-9]{1,2})(?![0-9])')
  $s2=$s
  if($mi.Success){ $s2=$s.Substring(0,$mi.Index)+(' '*$mi.Length)+$s.Substring($mi.Index+$mi.Length) }
  $md=[regex]::Match($s2,'(?:^|[^0-9])([0-9]{1,2})[/\-.]+([0-9]{1,2})[/\-.]+([0-9]{2,4})(?![0-9])')
  $a=''; $b=''
  if($mi.Success){ $a=Pick-Date (Yr ([int]$mi.Groups[1].Value)) ([int]$mi.Groups[2].Value) ([int]$mi.Groups[3].Value) }
  if($md.Success){ $b=Pick-Date (Yr ([int]$md.Groups[3].Value)) ([int]$md.Groups[2].Value) ([int]$md.Groups[1].Value) }
  if($a -and $b){ if($mi.Index -le $md.Index){ return $a }; return $b }
  if($a -or $b -or $mi.Success -or $md.Success){ if($a){ return $a }; return $b }
  # English month names ('28-Oct-25', '28 October 2025', 'Oct 28, 2025')
  $m=[regex]::Match($s,'(?:^|[^0-9])([0-9]{1,2})[\s\-/.]*([A-Za-z]{3,9})\.?[\s\-/.,]*([0-9]{2,4})(?![0-9])')
  if($m.Success){ $mn=Mon-No $m.Groups[2].Value; if($mn){ return (Pick-Date (Yr ([int]$m.Groups[3].Value)) $mn ([int]$m.Groups[1].Value)) } }
  $m=[regex]::Match($s,'(?:^|[^A-Za-z])([A-Za-z]{3,9})\.?\s*([0-9]{1,2}),?\s*([0-9]{4})(?![0-9])')
  if($m.Success){ $mn=Mon-No $m.Groups[1].Value; if($mn){ return (Pick-Date (Yr ([int]$m.Groups[3].Value)) $mn ([int]$m.Groups[2].Value)) } }
  return ''
}
# a date found in another cell: only cells that look like a date (app DATE_LIKE), never a bare number
function Date-Like($x){ if("$x" -match '[0-9]{1,4}[/\-.]+[0-9]{1,2}[/\-.]+[0-9]{1,4}'){ return (To-ISODate $x) }; return '' }
# a date-typed cell counts as DATE_LIKE only when its number format shows day, month and year as digits joined by / - .
# (the app reads SheetJS display text: those formats render as digits, format 14 as yyyy-mm-dd; month-name formats such as
# 'd-mmm-yy' / 'd mmm yyyy' (codes 15-17) render as '21-Jan-25' and the app skips them) - [..] tags dropped, "..." and \x literals unquoted
function Numeric-DateFormat($nf){ $f=((("$nf" -replace '\[[^\]]*\]','') -replace '"([^"]*)"','$1') -replace '\\(.)','$1'); return (($f -notmatch '(?i)mmm') -and ($f -match '(?i)[dmy]+[/\-.]+[dmy]+[/\-.]+[dmy]+')) }
# G02 swap day/month of a YYYY-MM-DD date ('' = not possible: day > 12, not a real date, or after today) - app swapDM
function Swap-DM($s){
  if("$s" -notmatch '^([0-9]{4})-([0-9]{2})-([0-9]{2})$'){ return '' }
  $y=[int]$Matches[1]; $mo=[int]$Matches[2]; $d=[int]$Matches[3]
  if($d -lt 1 -or $d -gt 12){ return '' }
  $sw=Ok-Date $y $d $mo
  if($sw -and [string]::CompareOrdinal($sw,$TODAYS) -le 0){ return $sw }
  return ''
}

# ---- keys
function Norm-Key($s){ return ("$s" -replace '[\s\-]','').ToUpper() }
# a usable match key contains a digit and is not a broken scientific number (app impKey)
function Imp-Key($s){ $k=Norm-Key $s; if(($k -match '[0-9]') -and ($k -notmatch 'E\+')){ return $k }; return '' }
function Is-Invoice($s){ return ($s -match '^(CIV|IV)[0-9]{8,}$') }
function Is-PA($s){ return ($s -match '^PA[0-9]{6,}$') }
function Is-Order($s){ return (($s -match '^[0-9]{14,19}$') -or ($s -match '^[0-9]{6}[A-Z0-9]{8}$')) }
# invoice number in a cell (app pickInv): whole cell, else split on / , ; | and take the first CIV (no CIV -> first IV)
function Pick-Inv($s){
  $w=Norm-Key $s
  if(Is-Invoice $w){ return $w }
  $t=@($w -split '[/,;|]+' | Where-Object { $_ -and (Is-Invoice $_) })
  $c=@($t | Where-Object { $_.StartsWith('CIV') })
  if($c.Count){ return $c[0] }
  if($t.Count){ return $t[0] }
  return ''
}
# first cell whose normalised value satisfies the predicate -> normalised value ('' = none)
function Row-FindKey($row,$pred){ foreach($x in $row){ if($x){ $k=Norm-Key $x; if($k -and (& $pred $k)){ return $k } } }; return '' }
function Order-Platform($s){
  if($s -match '^[0-9]{6}[A-Z0-9]{8}$'){ return 'SHOPEE_HUAWEI' }
  if($s -match '^5[0-9]{17}$'){ return 'TIKTOK_HUAWEI' }
  if($s -match '^1[0-9]{14,15}$'){ return 'Lazada_HUAWEI' }
  return ''
}
function Word-Platform($s){ $t=("$s").ToLower()
  if($t -match 'tiktok|tik tok'){return 'TIKTOK_HUAWEI'}; if($t -match 'shopee'){return 'SHOPEE_HUAWEI'}
  if($t -match 'lazada'){return 'Lazada_HUAWEI'}; if($t -match 'huawei_web|web'){return 'HUAWEI_Web'}; return '' }
function Extract-Carrier($t){ $s=("$t").ToLower(); foreach($c in $CARRIERS){ if($s.Contains($c.ToLower())){return $c} }; return '' }
function Extract-Tracking($t){ $s="$t"; if(!$s){return ''}
  $m=[regex]::Matches($s,'[A-Za-z]{0,4}[0-9][A-Za-z0-9]{7,}')
  if($m.Count){ return ($m | Sort-Object {$_.Value.Length} -Descending | Select-Object -First 1).Value }; return '' }
function Is-TrackText($s){ return ($s -match 'ตีกลับ|เลขที่ตีกลับ|J&T|FLASH|SPX|KERRY|EMS|LEX|KEX') }
function Norm-Condition($t){ $s="$t"
  if($s -match 'ไม่ใช่ของ|ไม่ใช้ของ|ไม่ใช่สินค้า'){return 'ได้รับสินค้าไม่ใช่ของ Huawei'}
  if($s -match 'ผิดรุ่น|ผิดสี|ผิดสินค้า'){return 'ได้รับสินค้าผิดรุ่น'}
  if($s -match 'คืนไม่ครบ'){return 'ได้รับสินค้าคืนไม่ครบ'}
  if($s -match 'ไม่ครบ'){return 'ได้รับสินค้าไม่ครบ'}
  if($s -match 'ไม่มีสินค้า|สินค้าหาย|กล่องเปล่า'){return 'สินค้าหาย'}
  if($s -match 'ชำรุด|เสียหาย|แตก|ร้าว'){return 'สินค้าชำรุดเสียหาย'}
  if($s -match 'บุบ'){return 'สินค้ากล่องบุบ'}
  if($s -match 'ยังไม่ได้แกะ|ยังไม่แกะ|ไม่ได้แกะ|ซีลอยู่'){return 'ยังไม่ได้แกะใช้งาน'}
  if($s -match 'แกะ'){return 'แกะสินค้าแล้ว'}
  return ''
}
function Norm-Reason($t){ $s="$t"
  if($s -match 'ออกจากคลัง'){return 'ยกเลิกก่อนออกจากคลัง'}
  if($s -match 'ยกเลิก'){return 'ยกเลิกก่อนจัดส่ง'}
  if($s -match 'ไม่ตรง|ผิดรุ่น|ผิดสี'){return 'สินค้าไม่ตรงที่สั่ง'}
  if($s -match 'ไม่ครบ'){return 'รับสินค้าไม่ครบ'}
  if($s -match 'ใช้งานไม่ได้|เปิดไม่ติด|ไม่ทำงาน|ชาร์จไม่เข้า|พัง|เสีย|ค้าง|ไม่ติด'){return 'ใช้งานไม่ได้'}
  if($s -match 'เปลี่ยนใจ|ไม่ต้องการ|สั่งผิด|กดเดิน|กดสั่ง|ไม่อยากได้'){return 'ลูกค้าเปลี่ยนใจ'}
  if($s -match 'ตีกลับ'){return 'ตีกลับจากขนส่ง'}
  return ''
}
function Is-Wrong($c){ return ($c -eq 'ได้รับสินค้าไม่ใช่ของ Huawei' -or $c -eq 'ได้รับสินค้าผิดรุ่น' -or $c -eq 'ได้รับสินค้าไม่ครบ' -or $c -eq 'ได้รับสินค้าคืนไม่ครบ') }
function Sheet-Status($n){
  if($n -match 'คืนสต็อก'){return 'ปิดงาน'}
  if($n -match 'ข้อพิพาท|ส่งคืนลูกค้า'){return 'ส่งคืนลูกค้า'}
  if($n -match 'ยังไม่ถึงคลัง'){return 'รอรับสินค้า'}
  if($n -match 'เครม|เคลม|service'){return 'เคลม Platform'}
  if($n -match 'ทำรับคืนระบบใหม่'){return 'รอทำรับคืน (CN)'}
  if($n -match 'ปัญหา'){return 'รอทดสอบ'}
  return 'ได้รับสินค้าแล้ว'
}
function Header-Cells($vals,$r,$cols){ $a=New-Object object[] $cols; for($c=1;$c -le $cols;$c++){ $a[$c-1]=(""+$vals[$r,$c]).Trim().ToLower() }; return ,$a }
function Find-Col($hdr,$syns){ foreach($s in $syns){ for($c=0;$c -lt $hdr.Length;$c++){ if($hdr[$c] -and $hdr[$c].Contains($s)){ return ($c+1) } } }; return -1 }
function Cell($vals,$r,$map,$k){ $col=$map[$k]; if($col -ge 0){ return (Get-Str $vals[$r,$col]) }; return '' }
function Row-Find($row,$pred){ for($i=0;$i -lt $row.Length;$i++){ if($row[$i] -and (& $pred $row[$i])){ return $row[$i] } }; return '' }
function First-Map($row,$fn){ foreach($x in $row){ if($x){ $v=& $fn $x; if($v){ return $v } } }; return '' }
function First-Cond($row){ foreach($x in $row){ if($x){ $n=Norm-Condition $x; if($n){ return ,@($n,$x) } } }; return ,@('','') }
function First-Match($row,$pattern){ foreach($x in $row){ if($x -and ($x -match $pattern)){ return $Matches[1] } }; return '' }
function First-Contains($row,$pattern){ foreach($x in $row){ if($x -and ($x -match $pattern)){ return $x } }; return '' }

$xl=New-Object -ComObject Excel.Application; $xl.Visible=$false; $xl.DisplayAlerts=$false
$wb=$null
try {
$wb=$xl.Workbooks.Open($src, 0, $true)
$all=New-Object System.Collections.ArrayList
$byInv=@{}; $byOrd=@{}; $report=@(); $idx=0; $repaired=0; $dmSwapped=0; $noKey=0
$stamp=[int][double]::Parse((Get-Date -UFormat %s),$CULT)
foreach($ws in $wb.Worksheets){
  $name=$ws.Name
  $ur=$ws.UsedRange; $cols=$ur.Columns.Count; $rowsN=$ur.Rows.Count
  if($cols -gt 80){ $report += "SKIP $name (cols=$cols)"; continue }
  $vals=$ur.Value2
  if($null -eq $vals){ $report += "SKIP $name (empty)"; continue }
  # typed values (DateTime for date-formatted cells) - the app sees those cells as formatted date text
  $typed=$ur.Value(10)
  $hRow=-1; $best=0
  for($r=1;$r -le [Math]::Min(6,$rowsN);$r++){
    $hdr=Header-Cells $vals $r $cols
    $score=0; foreach($f in $FIELDS){ if((Find-Col $hdr $SYN[$f]) -ge 0){ $score++ } }
    if($score -gt $best){ $best=$score; $hRow=$r }
  }
  if($hRow -lt 0 -or $best -lt 3){ $report += "SKIP $name (no header, best=$best)"; continue }
  $hdr=Header-Cells $vals $hRow $cols
  $map=@{}; foreach($f in $FIELDS){ $map[$f]=Find-Col $hdr $SYN[$f] }
  $status=Sheet-Status $name
  $isDispute=($name -match 'ข้อพิพาท')
  $scan=[Math]::Min($cols,20)
  $added=0; $merged=0; $fixedHere=0; $noKeyHere=0; $dmHere=0
  for($r=$hRow+1;$r -le $rowsN;$r++){
    $row=New-Object string[] $scan
    for($c=1;$c -le $scan;$c++){ $row[$c-1]=Get-Str $vals[$r,$c] }
    # G01/G03 invoice column: CIV/IV numbers only (Pick-Inv); never key on anything else
    $invRawS=Cell $vals $r $map 'invoiceNo'
    $invRaw=Norm-Key $invRawS
    $inv=Pick-Inv $invRaw
    $pa=Norm-Key (Cell $vals $r $map 'paNo'); $ord=Norm-Key (Cell $vals $r $map 'orderNo')
    $fixed=$false; $invNote=''
    if(!$inv){ foreach($x in $row){ if($x){ $pk=Pick-Inv $x; if($pk){ $inv=$pk; $fixed=$true; break } } } }
    if($invRaw -and $invRaw -ne $inv){
      if((Is-PA $invRaw) -and -not $pa){ $pa=$invRaw }
      elseif($invRaw -match '[0-9]'){ $invNote=('Invoice ในไฟล์: '+$invRawS) }
    }
    if(-not (Is-PA $pa)){ $pa=Row-FindKey $row ${function:Is-PA} }
    if(-not (Is-Order $ord)){ $cand=Row-FindKey $row ${function:Is-Order}; if($cand){ $ord=$cand; $fixed=$true } }
    # placeholder text ('Huawei', 'รอ CIV', 'N/A') or a broken scientific number is not a key
    $inv=Imp-Key $inv; $ord=Imp-Key $ord
    if(!$inv -and !$ord){ if(@($row | Where-Object { $_ }).Count){ $noKey++; $noKeyHere++ }; continue }
    # platform: word in mapped col, else any row cell word, else infer from order format
    $plat=Word-Platform (Cell $vals $r $map 'platform')
    if(!$plat){ $plat=First-Map $row ${function:Word-Platform} }
    if(!$plat){ $plat=Order-Platform $ord }
    if(!$plat){ $plat='TIKTOK_HUAWEI' }
    # condition & reason (normalised; original text kept in remark)
    $condRaw=Cell $vals $r $map 'condition'
    $cond=Norm-Condition $condRaw
    if(!$cond){ $pair=First-Cond $row; if($pair[0]){ $cond=$pair[0]; $condRaw=$pair[1]; $fixed=$true } }
    if(!$cond){ $cond='อื่นๆ' }
    $trackRaw=Cell $vals $r $map 'tracking'
    if(-not (Is-TrackText $trackRaw)){ $t2=Row-Find $row ${function:Is-TrackText}; if($t2){ $trackRaw=$t2 } }
    $reasonRaw=Cell $vals $r $map 'reason'
    $reason=Norm-Reason $reasonRaw
    if(!$reason -and ($trackRaw -match 'ตีกลับ')){ $reason='ตีกลับจากขนส่ง' }
    if(!$reason){ $reason='อื่นๆ' }
    # dates
    $draw=''; if($map['receivedDate'] -ge 0){ $draw=$vals[$r,$map['receivedDate']] }
    $rd=To-ISODate $draw
    # no date in the date column: first other cell holding a date - app DATE_LIKE fallback on the displayed text:
    # a date-formatted cell only when its format shows the date as digits (Numeric-DateFormat), or text that looks like a date
    if(!$rd){ for($c=1;$c -le $scan;$c++){ $tv=$typed[$r,$c]; if($tv -is [DateTime]){ if(Numeric-DateFormat ([string]$ur.Cells($r,$c).NumberFormat)){ $rd=Pick-Date $tv.Year $tv.Month $tv.Day } } else { $rd=Date-Like $row[$c-1] }; if($rd){ break } } }
    $sdRaw=''; if($map['stockDate'] -ge 0){ $sdRaw=$vals[$r,$map['stockDate']] }
    $sd=To-ISODate $sdRaw
    $handover=Cell $vals $r $map 'handover'
    if(!$sd -and $handover -and $status -eq 'ปิดงาน'){ $sd=To-ISODate $handover }
    # G02 return-to-stock date before the received date: received date typed with day/month swapped -> swap it back
    $rdNote=''
    if($rd -and $sd -and ([string]::CompareOrdinal($sd,$rd) -lt 0)){
      $sw=Swap-DM $rd
      if($sw -and ([string]::CompareOrdinal($sw,$sd) -le 0)){ $rdNote=('วันที่เดิม: '+$rd); $rd=$sw; $dmSwapped++; $dmHere++ }
    }
    # text in the แจ้งอีฟ column beyond a date (who handed what to whom) is kept in remark - no other field holds it
    $sdRawS=Get-Str $sdRaw
    $sdNote=''; if($sdRawS -match '[^0-9\s/\-.:]'){ $sdNote=('แจ้งอีฟ: '+$sdRawS) }
    # document numbers found anywhere in the row
    $cn=(First-Match $row '(CNRQ[0-9]{6,})').ToUpper()
    $ro=(First-Match $row '(RO[0-9]{9,})').ToUpper()
    $cc=(First-Match $row '(CCC?[0-9]{9,})').ToUpper()
    if(!$cc){ $cc=Cell $vals $r $map 'ccNo' }
    $box=First-Match $row 'กล่องที่\s*([0-9]+)'
    $sku=Cell $vals $r $map 'sku'; if($sku -notmatch '^HW-'){ $c2=Row-Find $row { param($v) $v -match '^HW-' }; if($c2){ $sku=$c2 } }
    $serial=Cell $vals $r $map 'serial'; $qty=Cell $vals $r $map 'qty'
    $trk=Extract-Tracking $trackRaw; if(!$trk){ $trk=$trackRaw }
    # dispute sheet: "ส่งสินค้าคืนลูกค้า RO... ชนะข้อพิพาท ขนส่ง DHL"
    $claimResult=''; $retCarrier=''
    $disputeText=First-Contains $row 'ข้อพิพาท|ส่งสินค้าคืนลูกค้า'
    if($disputeText){
      if($disputeText -match 'ชนะ'){ $claimResult='ชนะข้อพิพาท' } elseif($disputeText -match 'แพ้'){ $claimResult='แพ้ข้อพิพาท' }
      if($disputeText -match 'ขนส่ง\s*([A-Za-z&]+)'){ $retCarrier=Extract-Carrier $Matches[1] }
      if(!$retCarrier -and $isDispute){ $retCarrier=Extract-Carrier ($disputeText -replace '^.*ขนส่ง','') }
    }
    # a note saying the item was already sent back to the customer means the case is at least 'ส่งคืนลูกค้า'
    $rowStatus=$status
    if($disputeText -and ($disputeText -match 'ส่งสินค้าคืนลูกค้า|ส่งคืนลูกค้า') -and (Stage-Rank $rowStatus) -lt (Stage-Rank 'ส่งคืนลูกค้า')){ $rowStatus='ส่งคืนลูกค้า' }
    $claimDate=Cell $vals $r $map 'claimDate'
    # keep original legacy text so nothing is lost (same order as the app)
    $notes=@()
    if($condRaw -and $condRaw -ne $cond){ $notes += ('สภาพเดิม: '+$condRaw) }
    if($reasonRaw -and $reasonRaw -ne $reason){ $notes += ('เหตุผลเดิม: '+$reasonRaw) }
    $rm=Cell $vals $r $map 'remark'; if($rm){ $notes += $rm }
    if($disputeText -and -not $isDispute){ $notes += $disputeText }
    if($claimDate){ $notes += ('วันที่เคลม: '+$claimDate) }
    if($sdNote){ $notes += $sdNote }
    if($rdNote){ $notes += $rdNote }
    if($invNote){ $notes += $invNote }
    $created=(Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ',$CULT)
    if($rd){ $created=([DateTime]::ParseExact($rd,'yyyy-MM-dd',$CULT)).AddHours(10).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ',$CULT) }
    if($fixed){ $repaired++; $fixedHere++ }

    # dedupe: same CIV, or (no CIV match) same order number
    $pos=-1
    if($inv -and $byInv.ContainsKey($inv)){ $pos=$byInv[$inv] } elseif($ord -and $byOrd.ContainsKey($ord)){ $pos=$byOrd[$ord] }
    if($pos -ge 0){
      $ex=$all[$pos]
      if((Stage-Rank $rowStatus) -gt (Stage-Rank $ex.status)){ $ex.status=$rowStatus; if($sd){ $ex.stockDate=$sd } }
      foreach($pair in @(@('invoiceNo',$inv),@('orderNo',$ord),@('paNo',$pa),@('cnNo',$cn),@('roNo',$ro),@('sku',$sku),@('serial',$serial),@('qty',$qty),@('tracking',$trk),@('carrier',(Extract-Carrier $trackRaw)),@('ccNo',$cc),@('boxNo',$box),@('handoverNote',$handover),@('claimResult',$claimResult),@('returnCarrier',$retCarrier),@('receivedDate',$rd))){
        if(-not $ex.($pair[0]) -and $pair[1]){ $ex.($pair[0])=$pair[1] } }
      if($ex.condition -eq 'อื่นๆ' -and $cond -ne 'อื่นๆ'){ $ex.condition=$cond; $ex.wrongItem=[bool](Is-Wrong $cond) }
      if($ex.status -eq 'ปิดงาน' -and -not $ex.stockDate -and $sd){ $ex.stockDate=$sd }
      $ex.history += [ordered]@{at=$created;by='นำเข้า Excel';user='import';role='';action=('พบซ้ำใน sheet · '+$name)}
      if($inv -and -not $byInv.ContainsKey($inv)){ $byInv[$inv]=$pos }
      if($ord -and -not $byOrd.ContainsKey($ord)){ $byOrd[$ord]=$pos }
      $merged++; continue
    }
    $obj=[ordered]@{
      id="imp${stamp}_$idx"; createdAt=$created; updatedAt=$created
      receivedDate=$rd; invoiceNo=$inv; paNo=$pa; orderNo=$ord
      platform=$plat; sku=$sku; serial=$serial; qty=$qty
      condition=$cond; carrier=(Extract-Carrier $trackRaw); tracking=$trk
      ccNo=$cc; reason=$reason; remark=($notes -join ' | ')
      cnNo=$cn; roNo=$ro; returnCarrier=$retCarrier; returnTracking=''; claimNo=''; claimResult=$claimResult
      boxNo=$box; handoverNote=$handover
      testResult=''; testNote=''; status=$rowStatus; stockDate=$sd
      wrongItem=[bool](Is-Wrong $cond); images=@(); signature=$null
      history=@([ordered]@{at=$created;by='นำเข้า Excel';user='import';role='';action=('นำเข้าจาก Excel · '+$name)})
    }
    $pos=$all.Add((New-Object psobject -Property $obj)); $idx++; $added++
    if($inv){ $byInv[$inv]=$pos }; if($ord){ $byOrd[$ord]=$pos }
  }
  $report += "OK   $name  header=row$hRow added=$added merged=$merged repaired=$fixedHere nokey=$noKeyHere dmswap=$dmHere -> $status"
}
} finally {
  # always close the hidden Excel instance, also when a row throws
  if($wb){ try { $wb.Close($false) } catch {} }
  try { $xl.Quit() | Out-Null } catch {}
  [System.Runtime.Interopservices.Marshal]::ReleaseComObject($xl) | Out-Null
  [GC]::Collect(); [GC]::WaitForPendingFinalizers()
}

$json=$all | ConvertTo-Json -Depth 6 -Compress
[System.IO.File]::WriteAllText($out,$json,(New-Object System.Text.UTF8Encoding($false)))
"===== REPORT ====="; $report | ForEach-Object { $_ }
"TOTAL: $($all.Count) records  (row-repaired: $repaired, receivedDate day/month swapped: $dmSwapped, rows without a usable Invoice/Order: $noKey)"
"OUTPUT: $out  ($([Math]::Round((Get-Item $out).Length/1MB,2)) MB)"
