export function statusOf(score){
  return score>=90?"excellent":score>=80?"good":score>=70?"medium":score>=60?"weak":"danger";
}
